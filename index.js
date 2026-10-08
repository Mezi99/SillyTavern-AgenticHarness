/**
 * Agentic Harness — v1
 *
 * Pipeline: generate_interceptor -> Director (hidden call) -> code validates
 * whitelisted state mutations against a per-chat schema -> directive injected
 * via setExtensionPrompt -> ST generates the Author turn normally.
 *
 * Structure: house style (single IIFE, settings.html drawer, draggable window).
 * Install: public/scripts/extensions/third-party/agentic-harness/{manifest.json,index.js,settings.html,style.css}
 *
 * Verified against ST 1.18.0:
 *  - generate_interceptor: manifest field -> globalThis fn, awaited in script.js (runGenerationInterceptors)
 *  - generateRaw({prompt, systemPrompt, responseLength}): script.js, bypasses Generate() (no recursion)
 *  - extension_prompt_types/roles are NOT on getContext(): IN_CHAT=1, SYSTEM=0 are hardcoded below
 *  - saveChat on context = saveChatConditional; chatMetadata/saveMetadata exposed
 *  - MESSAGE_RECEIVED fires on all reply paths (normal/swipe/regenerate/streaming)
 */
(function () {
    'use strict';

    const MODULE_NAME = 'agentic_harness';
    const PROMPT_KEY = 'agentic_harness_directive';
    const INTERCEPTOR_NAME = 'agenticHarnessInterceptor';
    const RUN_TYPES = new Set(['normal', 'regenerate', 'swipe']); // skip quiet / impersonate / continue
    const IN_CHAT = 1;    // extension_prompt_types.IN_CHAT
    const SYSTEM_ROLE = 0; // extension_prompt_roles.SYSTEM
    const STATE_KEY = 'ah'; // message.extra.<key> namespace

    const DEFAULT_SETTINGS = {
        enabled: true,
        contextMessages: 6,
        directiveDepth: 0,
        retries: 1,
        responseLength: 1024,
        windowOpen: false,
        defaultTemplate: 'relationship',
        debugMode: false,
        directorSystemTemplate: null,
        directorUserTemplate: null,
        directiveWrapper: null,
    };

    let extension_settings;
    let saveSettingsDebounced;
    let pending = null; // Director result for the generation currently in flight
    let lastRun = null; // last Director run (even if the reply was never saved) — for Debugging Mode
    let busy = false;   // re-entrancy guard
    let windowCreated = false;
    let BASE_URL;

    // -----------------------------------------------------------------------
    // Schema templates (data, not code). Field types: counter, flag, enum, text.
    // counter mutations arrive as deltas; flag/enum/text are absolute sets.
    // -----------------------------------------------------------------------
    const FIELD_TYPES = ['counter', 'flag', 'enum', 'text'];

    const TEMPLATES = {
        relationship: {
            id: 'relationship',
            name: 'Relationship Focus',
            description: 'Tracks trust, affection and the current relationship stage with the main NPC.',
            fields: [
                { path: 'npc_disposition.trust_level', type: 'counter', initial: 5, min: 0, max: 10, maxStep: 2, description: 'How much the main NPC trusts the player right now (0 = hostile, 10 = absolute trust). Send a delta.' },
                { path: 'npc_disposition.affection', type: 'counter', initial: 0, min: 0, max: 10, maxStep: 1, description: 'Romantic/emotional affection the main NPC feels (0 = none, 10 = deeply attached). Send a delta.' },
                { path: 'npc_disposition.relationship_stage', type: 'enum', initial: 'strangers', values: ['strangers', 'acquainted', 'friends', 'close', 'intimate'], description: 'Current overall stage of the relationship. Change only on clear milestones.' },
                { path: 'plot_flags.current_topic', type: 'text', initial: 'first_meeting', maxLen: 60, description: 'Short label for what the conversation is currently about.' },
            ],
        },
        dungeon: {
            id: 'dungeon',
            name: 'Dungeon Crawl',
            description: 'Tracks party health, gold, location and trap/quest flags.',
            fields: [
                { path: 'party.health', type: 'counter', initial: 10, min: 0, max: 10, maxStep: 3, description: 'Party health pool (0 = wiped out, 10 = fully rested). Send a delta (damage negative, healing positive).' },
                { path: 'party.gold', type: 'counter', initial: 50, min: 0, max: 9999, maxStep: 200, description: 'Gold the party is carrying. Send a delta (spending negative, loot positive).' },
                { path: 'world_state.current_room', type: 'text', initial: 'Tavern Cellar', maxLen: 60, description: 'Where the party currently is.' },
                { path: 'world_state.is_guarded', type: 'flag', initial: true, description: 'Whether the current area is watched or dangerous.' },
                { path: 'plot_flags.current_quest', type: 'enum', initial: 'acquire_the_key', values: ['acquire_the_key', 'descend_deeper', 'escape_the_cellar', 'confront_the_guard'], description: 'The active quest objective.' },
            ],
        },
        mystery: {
            id: 'mystery',
            name: 'Mystery / Investigation',
            description: 'Tracks clues, theories and suspect cooperation.',
            fields: [
                { path: 'case.clues_found', type: 'counter', initial: 0, min: 0, max: 12, maxStep: 1, description: 'Number of meaningful clues uncovered so far. Send a delta (+1 per new clue).' },
                { path: 'case.solved', type: 'flag', initial: false, description: 'Whether the central mystery has been solved.' },
                { path: 'case.current_theory', type: 'text', initial: 'none', maxLen: 80, description: 'Short label for the investigator’s leading theory.' },
                { path: 'npc_disposition.suspect_cooperation', type: 'counter', initial: 5, min: 0, max: 10, maxStep: 2, description: 'How cooperative the key suspect is being (0 = stonewalling, 10 = confessing). Send a delta.' },
            ],
        },
    };

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------
    const ctx = () => SillyTavern.getContext();
    const clone = (o) => JSON.parse(JSON.stringify(o));

    function getBaseUrl() {
        const scripts = document.querySelectorAll('script[src*="index.js"]');
        for (const script of scripts) {
            if (script.src.includes('agentic-harness') || script.src.includes('AgenticHarness')) {
                return script.src.split('/').slice(0, -1).join('/');
            }
        }
        return '/scripts/extensions/third-party/agentic-harness';
    }

    function getSettings() {
        const s = extension_settings[MODULE_NAME];
        if (s.enabled === undefined) s.enabled = DEFAULT_SETTINGS.enabled;
        if (s.contextMessages === undefined) s.contextMessages = DEFAULT_SETTINGS.contextMessages;
        if (s.directiveDepth === undefined) s.directiveDepth = DEFAULT_SETTINGS.directiveDepth;
        if (s.retries === undefined) s.retries = DEFAULT_SETTINGS.retries;
        if (s.responseLength === undefined) s.responseLength = DEFAULT_SETTINGS.responseLength;
        if (s.windowOpen === undefined) s.windowOpen = DEFAULT_SETTINGS.windowOpen;
        if (s.defaultTemplate === undefined) s.defaultTemplate = DEFAULT_SETTINGS.defaultTemplate;
        if (s.debugMode === undefined) s.debugMode = DEFAULT_SETTINGS.debugMode;
        if (s.directorSystemTemplate === undefined) s.directorSystemTemplate = DEFAULT_SETTINGS.directorSystemTemplate;
        if (s.directorUserTemplate === undefined) s.directorUserTemplate = DEFAULT_SETTINGS.directorUserTemplate;
        if (s.directiveWrapper === undefined) s.directiveWrapper = DEFAULT_SETTINGS.directiveWrapper;
        return s;
    }

    function getPath(obj, path) {
        return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    }

    function setPath(obj, path, value) {
        const keys = path.split('.');
        const last = keys.pop();
        const parent = keys.reduce((o, k) => (o[k] ??= {}), obj);
        parent[last] = value;
    }

    // -----------------------------------------------------------------------
    // Schema engine: validation + state construction + Director description
    // -----------------------------------------------------------------------
    function validateSchema(schema) {
        const errors = [];
        if (!Array.isArray(schema) || schema.length === 0) {
            return { ok: false, errors: ['schema must be a non-empty array of fields'] };
        }
        const seen = new Set();
        for (let i = 0; i < schema.length; i++) {
            const f = schema[i];
            const at = `field[${i}]`;
            if (!f || typeof f !== 'object') { errors.push(`${at}: must be an object`); continue; }
            if (typeof f.path !== 'string' || !/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/.test(f.path)) {
                errors.push(`${at}: invalid path "${f.path}" (use dotted.identifier)`); continue;
            }
            if (seen.has(f.path)) errors.push(`${at}: duplicate path "${f.path}"`);
            seen.add(f.path);
            if (!FIELD_TYPES.includes(f.type)) { errors.push(`${at}: unknown type "${f.type}"`); continue; }
            if (typeof f.description !== 'string' || !f.description.trim()) {
                errors.push(`${at}: description is required (the Director judges changes by it)`);
            }
            if (f.type === 'counter') {
                if (!Number.isFinite(f.min) || !Number.isFinite(f.max)) errors.push(`${at}: counter needs numeric min/max`);
                else if (f.min > f.max) errors.push(`${at}: min > max`);
                if (!Number.isFinite(f.maxStep) || f.maxStep <= 0) errors.push(`${at}: counter needs a positive maxStep`);
                if (!Number.isFinite(f.initial) || f.initial < f.min || f.initial > f.max) errors.push(`${at}: initial out of [min,max]`);
            } else if (f.type === 'flag') {
                if (typeof f.initial !== 'boolean') errors.push(`${at}: flag initial must be boolean`);
            } else if (f.type === 'enum') {
                if (!Array.isArray(f.values) || f.values.length === 0) errors.push(`${at}: enum needs a non-empty values array`);
                else if (!f.values.includes(f.initial)) errors.push(`${at}: initial not in values`);
            } else if (f.type === 'text') {
                if (typeof f.initial !== 'string') errors.push(`${at}: text initial must be a string`);
                if (f.maxLen !== undefined && (!Number.isFinite(f.maxLen) || f.maxLen <= 0)) errors.push(`${at}: maxLen must be a positive number`);
            }
        }
        return { ok: errors.length === 0, errors };
    }

    function initialFromSchema(schema) {
        const state = {};
        for (const f of schema) setPath(state, f.path, clone(f.initial));
        return state;
    }

    /** Rebuild a state object so it exactly matches the schema paths. */
    function reconcileState(oldState, schema) {
        const next = {};
        for (const f of schema) {
            const v = getPath(oldState ?? {}, f.path);
            setPath(next, f.path, v === undefined ? clone(f.initial) : v);
        }
        return next;
    }

    function describeSchema(schema) {
        return schema.map((f) => {
            const head = `- "${f.path}" (${f.type}): ${f.description}`;
            if (f.type === 'counter') return `${head} Range ${f.min}-${f.max}, send a delta of at most +/-${f.maxStep}.`;
            if (f.type === 'enum') return `${head} One of: ${JSON.stringify(f.values)}.`;
            if (f.type === 'flag') return `${head} true or false.`;
            return `${head} Max ${f.maxLen ?? 100} characters.`;
        }).join('\n');
    }

    // -----------------------------------------------------------------------
    // Per-chat state: baseline + schema in chat_metadata, snapshots per message
    // -----------------------------------------------------------------------
    function ensureChatState() {
        const m = ctx().chatMetadata;
        m[MODULE_NAME] ??= {};
        const st = m[MODULE_NAME];
        let created = false;

        if (!Array.isArray(st.schema) || validateSchema(st.schema).ok === false) {
            const tpl = TEMPLATES[getSettings().defaultTemplate] ?? TEMPLATES.relationship;
            st.schema = clone(tpl.fields);
            st.templateId = tpl.id;
            created = true;
        }
        if (!st.baseline || typeof st.baseline !== 'object') {
            st.baseline = initialFromSchema(st.schema);
            created = true;
        } else {
            st.baseline = reconcileState(st.baseline, st.schema);
        }
        if (created) ctx().saveMetadata?.();
        return st;
    }

    function chatBaseline() {
        return ensureChatState();
    }

    /** Last snapshot at or before `fromIndex` (searching backwards). */
    function findSnapshot(fromIndex) {
        const chat = ctx().chat;
        for (let i = Math.min(fromIndex, chat.length - 1); i >= 0; i--) {
            const snap = chat[i]?.extra?.[STATE_KEY]?.state;
            if (snap) return { state: snap, index: i };
        }
        return null;
    }

    /**
     * State to feed the Director = snapshot from the last AI message BEFORE the
     * user message being answered. Same for normal, swipe and regenerate,
     * because the reply being replaced always sits after that user message.
     */
    function getBaseState() {
        const chat = ctx().chat;
        let lastUser = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i].is_user) { lastUser = i; break; }
        }
        const from = lastUser === -1 ? chat.length - 1 : lastUser - 1;
        return clone(findSnapshot(from)?.state ?? chatBaseline().baseline);
    }

    /** What the window shows: the newest snapshot in the chat, else the baseline. */
    function getCurrentState() {
        return clone(findSnapshot(ctx().chat.length - 1)?.state ?? chatBaseline().baseline);
    }

    /** Manual edit from the window: patch the newest snapshot (or the baseline if none). */
    async function setCurrentState(state) {
        const snap = findSnapshot(ctx().chat.length - 1);
        if (snap) ctx().chat[snap.index].extra[STATE_KEY].state = state;
        else chatBaseline().baseline = state;
        await ctx().saveMetadata?.();
        await ctx().saveChat?.();
    }

    // -----------------------------------------------------------------------
    // Harness logic engine: validate + apply mutations (the LLM proposes, code decides)
    // -----------------------------------------------------------------------
    function validateMutation(field, raw, current) {
        switch (field.type) {
            case 'counter': {
                const d = Number(raw);
                if (!Number.isFinite(d)) return { ok: false, reason: 'not a number' };
                const step = Math.max(-field.maxStep, Math.min(field.maxStep, d));
                const base = Number.isFinite(current) ? current : field.initial;
                return { ok: true, value: Math.max(field.min, Math.min(field.max, base + step)) };
            }
            case 'flag':
                if (typeof raw !== 'boolean') return { ok: false, reason: 'not a boolean' };
                return { ok: true, value: raw };
            case 'enum':
                if (!field.values.includes(raw)) return { ok: false, reason: 'not in enum' };
                return { ok: true, value: raw };
            case 'text':
                if (typeof raw !== 'string') return { ok: false, reason: 'not a string' };
                return { ok: true, value: raw.slice(0, field.maxLen ?? 100) };
            default:
                return { ok: false, reason: 'unknown field type' };
        }
    }

    function applyMutations(state, mutations, schema) {
        const next = clone(state);
        const applied = {};
        const rejected = {};
        const byPath = new Map(schema.map((f) => [f.path, f]));

        for (const [path, raw] of Object.entries(mutations ?? {})) {
            const field = byPath.get(path);
            if (!field) { rejected[path] = 'unknown key'; continue; }
            const res = validateMutation(field, raw, getPath(next, path));
            if (!res.ok) { rejected[path] = res.reason; continue; }
            setPath(next, path, res.value);
            applied[path] = res.value;
        }
        return { next, applied, rejected };
    }

    // -----------------------------------------------------------------------
    // Prompt templates (editable in Debugging Mode; null/empty = built-in default)
    // -----------------------------------------------------------------------
    const DEFAULT_SYSTEM_TEMPLATE = [
        'You are the Game Master. Evaluate the player\'s latest action against the current world state.',
        'Output ONLY valid JSON, no prose, no code fences, matching:',
        '{ "state_mutations": { "<path>": <value> }, "narrative_directives": "string" }',
        'state_mutations: only include paths that change this turn. For counters send a signed delta,',
        'for flags/enums/text send the new absolute value. Omit paths that do not change.',
        'Fields:',
        '{{fields}}',
        'narrative_directives: 1-4 imperative sentences telling the narrator how NPCs act and what happens this turn.',
        'Never speak for the player. If nothing changes, use empty objects and empty string.',
    ].join('\n');

    const DEFAULT_USER_TEMPLATE = '# Current state\n{{state}}\n\n# Recent chat\n{{transcript}}';

    const DEFAULT_DIRECTIVE_WRAPPER = '[Director\'s note for this turn: {{directive}}]';

    function renderTemplate(tpl, vars) {
        return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
    }

    function systemTemplate() {
        return getSettings().directorSystemTemplate || DEFAULT_SYSTEM_TEMPLATE;
    }

    function userTemplate() {
        return getSettings().directorUserTemplate || DEFAULT_USER_TEMPLATE;
    }

    function directiveWrapper() {
        return getSettings().directiveWrapper || DEFAULT_DIRECTIVE_WRAPPER;
    }

    function renderDirective(directiveText) {
        return renderTemplate(directiveWrapper(), { directive: directiveText });
    }

    // -----------------------------------------------------------------------
    // Director
    // -----------------------------------------------------------------------
    function buildDirectorPrompt(chat, state, schema) {
        const n = getSettings().contextMessages;
        const transcript = chat
            .filter((m) => !m.is_system && typeof m.mes === 'string' && m.mes.trim())
            .slice(-n)
            .map((m) => `${m.name || (m.is_user ? 'Player' : 'Narrator')}: ${m.mes.trim()}`)
            .join('\n\n');

        const systemPrompt = renderTemplate(systemTemplate(), { fields: describeSchema(schema) });
        const prompt = renderTemplate(userTemplate(), {
            state: JSON.stringify(state, null, 2),
            transcript,
        });
        return { systemPrompt, prompt };
    }

    function extractJson(text) {
        const cleaned = String(text)
            .replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, '')
            .replace(/```(?:json)?/gi, '');
        const a = cleaned.indexOf('{');
        const b = cleaned.lastIndexOf('}');
        if (a === -1 || b <= a) throw new Error('no JSON object found');
        return JSON.parse(cleaned.slice(a, b + 1));
    }

    async function runDirector(chat, state, schema) {
        const s = getSettings();
        const { systemPrompt, prompt } = buildDirectorPrompt(chat, state, schema);
        let lastErr;

        for (let attempt = 0; attempt <= s.retries; attempt++) {
            try {
                const raw = await ctx().generateRaw({ prompt, systemPrompt, responseLength: s.responseLength });
                const json = extractJson(raw);
                if (typeof json.narrative_directives !== 'string') json.narrative_directives = '';
                if (json.state_mutations !== undefined && (typeof json.state_mutations !== 'object' || json.state_mutations === null)) {
                    json.state_mutations = {};
                }
                return { json, raw, systemPrompt, prompt };
            } catch (err) {
                lastErr = err;
            }
        }
        throw lastErr;
    }

    // -----------------------------------------------------------------------
    // Directive injection
    // -----------------------------------------------------------------------
    function setDirective(text) {
        ctx().setExtensionPrompt(PROMPT_KEY, text, IN_CHAT, getSettings().directiveDepth, false, SYSTEM_ROLE);
    }

    // -----------------------------------------------------------------------
    // Interceptor (named in manifest.json as "generate_interceptor")
    // -----------------------------------------------------------------------
    globalThis[INTERCEPTOR_NAME] = async function (chat, contextSize, abort, type) {
        if (!extension_settings) return; // init() not done yet
        // Always start clean so a skipped/failed run can never leave a stale directive behind.
        setDirective('');
        pending = null;

        const s = getSettings();
        if (!s.enabled || busy || !RUN_TYPES.has(type ?? 'normal')) return;
        if (ctx().groupId) return; // v1: single-character chats only
        if (!ctx().chatId) return; // no chat loaded

        busy = true;
        try {
            const st = ensureChatState();
            const before = getBaseState();
            const { json, raw, systemPrompt, prompt } = await runDirector(chat, before, st.schema);
            const { next, applied, rejected } = applyMutations(before, json.state_mutations ?? {}, st.schema);

            pending = {
                stateAfter: next,
                directives: json.narrative_directives.trim(),
                applied,
                rejected,
                raw,
                sysPrompt: systemPrompt,
                userPrompt: prompt,
            };
            lastRun = {
                directives: pending.directives,
                applied,
                rejected,
                raw,
                sysPrompt: systemPrompt,
                userPrompt: prompt,
                at: Date.now(),
            };
            renderDebugSection();

            if (pending.directives) {
                setDirective(renderDirective(pending.directives));
            }
        } catch (err) {
            // Never block the user's turn: fall back to a plain generation.
            console.warn('[AgenticHarness] Director failed, generating without it:', err);
            globalThis.toastr?.warning('Director failed; generating without it.', 'Agentic Harness');
            let attempted = null;
            try { attempted = buildDirectorPrompt(chat, before, st.schema); } catch { /* schema unavailable */ }
            lastRun = {
                error: String(err?.message ?? err),
                sysPrompt: attempted?.systemPrompt ?? '',
                userPrompt: attempted?.prompt ?? '',
                at: Date.now(),
            };
            renderDebugSection();
        } finally {
            busy = false;
        }
    };

    // -----------------------------------------------------------------------
    // Attach the pending result to the AI message that was just produced
    // -----------------------------------------------------------------------
    async function onMessageReceived(messageId) {
        // Directive is no longer needed once the reply exists; prevents leaking
        // into other extensions' quiet calls that may run between turns.
        setDirective('');

        if (!pending) return;
        const msg = ctx().chat[messageId];
        if (!msg || msg.is_user || msg.is_system) return;

        msg.extra ??= {};
        // v1 limitation: one snapshot per message, not per swipe. Swiping back to
        // an older swipe keeps the newest swipe's snapshot. Fix: swipe_info[i].extra.
        msg.extra[STATE_KEY] = {
            state: pending.stateAfter,
            directives: pending.directives,
            applied: pending.applied,
            rejected: pending.rejected,
            director_raw: pending.raw,
            director_sys_prompt: pending.sysPrompt,
            director_user_prompt: pending.userPrompt,
        };
        pending = null;

        await ctx().saveChat?.();
        refreshWindow();
        renderDebugSection();
    }

    // -----------------------------------------------------------------------
    // Draggable window: state editor, schema editor, Director log
    // -----------------------------------------------------------------------
    function buildLogText() {
        const chat = ctx().chat;
        const parts = [];
        for (let i = 0; i < chat.length; i++) {
            const ah = chat[i]?.extra?.[STATE_KEY];
            if (!ah) continue;
            const who = chat[i].is_user ? 'player' : (chat[i].name || 'ai');
            parts.push(`--- message #${i} (${who}) ---`);
            if (ah.directives) parts.push(`directives: ${ah.directives}`);
            parts.push(`applied: ${JSON.stringify(ah.applied ?? {})}`);
            const rej = Object.keys(ah.rejected ?? {});
            if (rej.length) parts.push(`rejected: ${JSON.stringify(ah.rejected)}`);
            const raw = String(ah.director_raw ?? '').slice(0, 800);
            parts.push(`raw: ${raw}${String(ah.director_raw ?? '').length > 800 ? '…' : ''}`);
            parts.push('');
        }
        return parts.length ? parts.join('\n') : '(no Director output yet)';
    }

    function refreshWindow() {
        if (!windowCreated) return;
        const stateEl = document.getElementById('ah-win-state');
        const schemaEl = document.getElementById('ah-win-schema');
        const logEl = document.getElementById('ah-win-log');
        if (stateEl && document.activeElement !== stateEl) {
            stateEl.value = JSON.stringify(getCurrentState(), null, 2);
        }
        if (schemaEl && document.activeElement !== schemaEl) {
            schemaEl.value = JSON.stringify(chatBaseline().schema, null, 2);
        }
        if (logEl) {
            logEl.textContent = buildLogText();
            logEl.scrollTop = logEl.scrollHeight;
        }
    }

    function setWinStatus(text, ok) {
        const el = document.getElementById('ah-win-status');
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('ah-ok', !!ok);
        el.classList.toggle('ah-err', !ok);
    }

    function createWindow() {
        if (windowCreated) return;

        const win = document.createElement('div');
        win.id = 'ah-window';
        win.className = 'ah-window is-hidden';
        win.innerHTML = `
            <div class="ah-win-header" id="ah-win-header">
                <span class="ah-win-title"><i class="fa-solid fa-diagram-project"></i> Agentic Harness</span>
                <button class="ah-win-close" id="ah-win-close" title="Hide window">×</button>
            </div>
            <div class="ah-win-body">
                <div class="ah-win-status" id="ah-win-status"></div>

                <details class="ah-win-section" open>
                    <summary><i class="fa-solid fa-flask"></i> World State</summary>
                    <div class="ah-win-section-body">
                        <div class="ah-win-meta">Current state (newest snapshot). Edits patch the newest snapshot, or the baseline if there are no snapshots yet.</div>
                        <textarea id="ah-win-state" class="text_pole ah-win-editor" rows="8" spellcheck="false"></textarea>
                        <div class="ah-win-actions">
                            <div id="ah-win-state-apply" class="menu_button">Apply state</div>
                            <div id="ah-win-state-reset" class="menu_button">Reset to baseline</div>
                        </div>
                    </div>
                </details>

                <details class="ah-win-section">
                    <summary><i class="fa-solid fa-list-check"></i> Schema</summary>
                    <div class="ah-win-section-body">
                        <div class="ah-win-meta">Fields the Director may mutate (counter | flag | enum | text). Paths must be dotted identifiers; every field needs a description.</div>
                        <textarea id="ah-win-schema" class="text_pole ah-win-editor" rows="10" spellcheck="false"></textarea>
                        <div class="ah-win-actions">
                            <div id="ah-win-schema-apply" class="menu_button">Apply schema</div>
                        </div>
                    </div>
                </details>

                <details class="ah-win-section">
                    <summary><i class="fa-solid fa-terminal"></i> Director Log</summary>
                    <div class="ah-win-section-body">
                        <div class="ah-win-log" id="ah-win-log"></div>
                    </div>
                </details>
            </div>
        `;
        document.body.appendChild(win);

        document.getElementById('ah-win-close').addEventListener('click', () => {
            setWindowVisible(false);
            extension_settings[MODULE_NAME].windowOpen = false;
            const toggle = document.getElementById('ah_open_window');
            if (toggle) toggle.checked = false;
            saveSettingsDebounced();
        });

        document.getElementById('ah-win-state-apply').addEventListener('click', async () => {
            try {
                const parsed = JSON.parse(document.getElementById('ah-win-state').value);
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
                await setCurrentState(parsed);
                setWinStatus('State updated.', true);
                refreshWindow();
            } catch (e) {
                setWinStatus(`Invalid state JSON: ${e.message}`, false);
            }
        });

        document.getElementById('ah-win-state-reset').addEventListener('click', async () => {
            chatBaseline().baseline = initialFromSchema(chatBaseline().schema);
            await ctx().saveMetadata?.();
            setWinStatus('Baseline reset to schema initials. Snapshots are untouched.', true);
            refreshWindow();
        });

        document.getElementById('ah-win-schema-apply').addEventListener('click', async () => {
            try {
                const parsed = JSON.parse(document.getElementById('ah-win-schema').value);
                const v = validateSchema(parsed);
                if (!v.ok) throw new Error(v.errors.join('; '));
                const st = chatBaseline();
                st.schema = parsed;
                st.baseline = reconcileState(st.baseline, parsed);
                await ctx().saveMetadata?.();
                setWinStatus(`Schema applied (${parsed.length} fields). Baseline reconciled; snapshots untouched.`, true);
                refreshWindow();
            } catch (e) {
                setWinStatus(`Invalid schema: ${e.message}`, false);
            }
        });

        // Drag (Internal States pattern)
        const header = win.querySelector('.ah-win-header');
        let isDragging = false;
        let startX, startY, initialX, initialY;
        header.addEventListener('mousedown', function (e) {
            if (e.target.closest('.ah-win-close')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = win.getBoundingClientRect();
            initialX = rect.left;
            initialY = rect.top;
            win.style.cursor = 'grabbing';
            e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
            if (!isDragging) return;
            win.style.left = (initialX + e.clientX - startX) + 'px';
            win.style.top = (initialY + e.clientY - startY) + 'px';
            win.style.right = 'auto';
            win.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', function () {
            if (isDragging) {
                isDragging = false;
                win.style.cursor = '';
            }
        });
        header.style.cursor = 'grab';

        windowCreated = true;
        refreshWindow();
    }

    function setWindowVisible(visible) {
        createWindow();
        document.getElementById('ah-window').classList.toggle('is-hidden', !visible);
        if (visible) refreshWindow();
    }

    function syncWindowToggle() {
        const toggle = document.getElementById('ah_open_window');
        if (toggle) toggle.checked = !!extension_settings[MODULE_NAME].windowOpen;
    }

    // -----------------------------------------------------------------------
    // Debugging Mode: Prompts and Templates
    // -----------------------------------------------------------------------
    let testRunning = false;

    function dbgSetText(id, text) {
        const el = document.getElementById(id);
        if (el) el.value = text ?? '';
    }

    function setDbgStatus(text, kind) {
        const el = document.getElementById('ah_dbg_status');
        if (!el) return;
        el.textContent = text ?? '';
        el.classList.toggle('ah-ok', kind === 'ok');
        el.classList.toggle('ah-err', kind === 'err');
        el.classList.toggle('ah-warn', kind === 'warn');
    }

    /** Fill template editors, previews, last-run and the built-in templates. */
    function renderDebugSection() {
        const s = getSettings();
        const toggle = document.getElementById('ah_debug_enabled');
        if (toggle) toggle.checked = s.debugMode;
        const content = document.getElementById('ah_debug_content');
        if (content) content.hidden = !s.debugMode;
        if (!s.debugMode) return;

        const fillUnlessFocused = (id, text) => {
            const el = document.getElementById(id);
            if (el && document.activeElement !== el) el.value = text ?? '';
        };

        fillUnlessFocused('ah_dbg_sys_tpl', systemTemplate());
        fillUnlessFocused('ah_dbg_user_tpl', userTemplate());
        fillUnlessFocused('ah_dbg_wrap_tpl', directiveWrapper());

        // Live preview: what would be sent on the next turn
        if (ctx().chatId && !ctx().groupId) {
            try {
                const st = ensureChatState();
                const { systemPrompt, prompt } = buildDirectorPrompt(ctx().chat, getBaseState(), st.schema);
                dbgSetText('ah_dbg_sys_live', systemPrompt);
                dbgSetText('ah_dbg_user_live', prompt);
            } catch (e) {
                dbgSetText('ah_dbg_sys_live', `(preview error: ${e.message})`);
                dbgSetText('ah_dbg_user_live', '');
            }
        } else {
            dbgSetText('ah_dbg_sys_live', '(open a single-character chat to preview)');
            dbgSetText('ah_dbg_user_live', '(open a single-character chat to preview)');
        }

        // Last executed run
        if (lastRun) {
            const at = new Date(lastRun.at).toLocaleTimeString();
            const metaEl = document.getElementById('ah_dbg_last_meta');
            if (metaEl) {
                metaEl.textContent = lastRun.error
                    ? `Last run ${at}: FAILED — ${lastRun.error}`
                    : `Last run ${at}: OK — applied ${JSON.stringify(lastRun.applied ?? {})}` +
                        (Object.keys(lastRun.rejected ?? {}).length ? `, rejected ${JSON.stringify(lastRun.rejected)}` : '');
            }
            dbgSetText('ah_dbg_sys_last', lastRun.sysPrompt ?? '');
            dbgSetText('ah_dbg_user_last', lastRun.userPrompt ?? '');
            dbgSetText('ah_dbg_result_last', lastRun.error
                ? `ERROR: ${lastRun.error}`
                : `raw:\n${lastRun.raw}\n\napplied: ${JSON.stringify(lastRun.applied ?? {}, null, 2)}\nrejected: ${JSON.stringify(lastRun.rejected ?? {}, null, 2)}`);
            dbgSetText('ah_dbg_directive_last', lastRun.directives ? renderDirective(lastRun.directives) : '(no directive in last run)');
        } else {
            const metaEl = document.getElementById('ah_dbg_last_meta');
            if (metaEl) metaEl.textContent = 'No Director run yet in this session.';
            dbgSetText('ah_dbg_sys_last', '');
            dbgSetText('ah_dbg_user_last', '');
            dbgSetText('ah_dbg_result_last', '');
            dbgSetText('ah_dbg_directive_last', '');
        }

        // Built-in schema templates
        dbgSetText('ah_dbg_tpl_relationship', JSON.stringify(TEMPLATES.relationship, null, 2));
        dbgSetText('ah_dbg_tpl_dungeon', JSON.stringify(TEMPLATES.dungeon, null, 2));
        dbgSetText('ah_dbg_tpl_mystery', JSON.stringify(TEMPLATES.mystery, null, 2));
    }

    function bindTemplateEditor(textId, applyId, resetId, settingKey, requiredKeys) {
        jQuery('#' + applyId).on('click', () => {
            const v = document.getElementById(textId).value;
            if (!v || !v.trim()) {
                setDbgStatus('Template is empty — keeping the previous value (use Reset to restore the default).', 'warn');
                return;
            }
            getSettings()[settingKey] = v;
            saveSettingsDebounced();
            const missing = requiredKeys.filter((k) => !v.includes(`{{${k}}}`));
            if (missing.length) {
                setDbgStatus(`Applied — warning: missing placeholder(s) ${missing.map((k) => `{{${k}}}`).join(', ')}`, 'warn');
            } else {
                setDbgStatus('Template applied.', 'ok');
            }
            renderDebugSection();
        });
        jQuery('#' + resetId).on('click', () => {
            getSettings()[settingKey] = null;
            saveSettingsDebounced();
            setDbgStatus('Reset to built-in default.', 'ok');
            renderDebugSection();
        });
    }

    /** Dry-run: send the live preview prompt once, show the result, change nothing. */
    async function testDirector() {
        if (testRunning) return;
        if (busy) {
            setDbgStatus('A generation is in progress — run the test after it finishes.', 'warn');
            return;
        }
        if (!ctx().chatId || ctx().groupId) {
            setDbgStatus('Open a single-character chat first.', 'warn');
            return;
        }
        testRunning = true;
        const testBtn = document.getElementById('ah_dbg_test');
        if (testBtn) testBtn.classList.add('ah-busy');
        setDbgStatus('Running Test Director…', 'ok');
        dbgSetText('ah_dbg_test_out', '');
        const t0 = Date.now();
        try {
            const st = ensureChatState();
            const base = getBaseState();
            const { systemPrompt, prompt } = buildDirectorPrompt(ctx().chat, base, st.schema);
            const raw = await ctx().generateRaw({ prompt, systemPrompt, responseLength: getSettings().responseLength });
            const ms = Date.now() - t0;
            const json = extractJson(raw);
            if (typeof json.narrative_directives !== 'string') json.narrative_directives = '';
            if (json.state_mutations !== undefined && (typeof json.state_mutations !== 'object' || json.state_mutations === null)) {
                json.state_mutations = {};
            }
            const { next, applied, rejected } = applyMutations(base, json.state_mutations ?? {}, st.schema);

            let out = `(${ms} ms)\n--- RAW ---\n${raw}\n\n`;
            out += `--- PARSED ---\n${JSON.stringify(json, null, 2)}\n\n`;
            out += `--- WOULD APPLY (nothing saved, nothing injected) ---\n`;
            out += `applied: ${JSON.stringify(applied, null, 2)}\nrejected: ${JSON.stringify(rejected, null, 2)}\n\n`;
            out += `--- STATE AFTER (preview only) ---\n${JSON.stringify(next, null, 2)}`;
            if (json.narrative_directives.trim()) {
                out += `\n\n--- DIRECTIVE (not injected) ---\n${renderDirective(json.narrative_directives.trim())}`;
            }
            dbgSetText('ah_dbg_test_out', out);
            setDbgStatus(`Test OK (${ms} ms). Nothing was applied or injected.`, 'ok');
        } catch (e) {
            dbgSetText('ah_dbg_test_out', String(e?.stack || e));
            setDbgStatus(`Test failed: ${e?.message ?? e}`, 'err');
        } finally {
            testRunning = false;
            if (testBtn) testBtn.classList.remove('ah-busy');
        }
    }

    function bindDebugSection() {
        jQuery('#ah_debug_enabled').on('change', function () {
            getSettings().debugMode = jQuery(this).is(':checked');
            saveSettingsDebounced();
            renderDebugSection();
        });

        bindTemplateEditor('ah_dbg_sys_tpl', 'ah_dbg_sys_apply', 'ah_dbg_sys_reset', 'directorSystemTemplate', ['fields']);
        bindTemplateEditor('ah_dbg_user_tpl', 'ah_dbg_user_apply', 'ah_dbg_user_reset', 'directorUserTemplate', ['state', 'transcript']);
        bindTemplateEditor('ah_dbg_wrap_tpl', 'ah_dbg_wrap_apply', 'ah_dbg_wrap_reset', 'directiveWrapper', ['directive']);

        jQuery('#ah_dbg_refresh').on('click', () => {
            renderDebugSection();
            setDbgStatus('Previews refreshed.', 'ok');
        });
        jQuery('#ah_dbg_test').on('click', () => { void testDirector(); });

        const promptsBlock = document.getElementById('ah_prompts_block');
        if (promptsBlock) {
            promptsBlock.addEventListener('toggle', () => {
                if (promptsBlock.open) renderDebugSection();
            });
        }
    }

    // -----------------------------------------------------------------------
    // Settings drawer
    // -----------------------------------------------------------------------
    async function loadSettings() {
        try {
            const resp = await fetch(`${BASE_URL}/settings.html`);
            if (resp.ok) {
                const html = await resp.text();
                jQuery('#extensions_settings').append(html);
            }
        } catch (err) {
            console.error('Agentic Harness: Failed to load settings:', err);
        }
    }

    function populateTemplateSelect() {
        const sel = document.getElementById('ah_template');
        if (!sel) return;
        sel.innerHTML = '';
        for (const tpl of Object.values(TEMPLATES)) {
            const opt = document.createElement('option');
            opt.value = tpl.id;
            opt.textContent = tpl.name;
            opt.title = tpl.description;
            sel.appendChild(opt);
        }
        sel.value = getSettings().defaultTemplate;
    }

    function bindDrawer() {
        const s = getSettings();

        jQuery('#ah_enabled').on('change', function () {
            s.enabled = jQuery(this).is(':checked');
            saveSettingsDebounced();
        });

        jQuery('#ah_open_window').on('change', function () {
            const open = jQuery(this).is(':checked');
            s.windowOpen = open;
            saveSettingsDebounced();
            setWindowVisible(open);
        });

        const bindNumber = (id, key) => {
            jQuery(id).on('change', function () {
                const v = parseInt(jQuery(this).val(), 10);
                if (Number.isFinite(v)) {
                    s[key] = v;
                    saveSettingsDebounced();
                }
            });
        };
        bindNumber('#ah_context', 'contextMessages');
        bindNumber('#ah_depth', 'directiveDepth');
        bindNumber('#ah_retries', 'retries');
        bindNumber('#ah_resplen', 'responseLength');

        jQuery('#ah_template_apply').on('click', async () => {
            const id = document.getElementById('ah_template').value;
            const tpl = TEMPLATES[id];
            if (!tpl) return;
            if (!confirm(`Load "${tpl.name}" into this chat?\n\nThis replaces the schema and resets the state baseline.`)) return;
            const st = ensureChatState();
            st.schema = clone(tpl.fields);
            st.templateId = tpl.id;
            st.baseline = initialFromSchema(tpl.fields);
            s.defaultTemplate = tpl.id;
            saveSettingsDebounced();
            await ctx().saveMetadata?.();
            globalThis.toastr?.success(`Template "${tpl.name}" loaded.`, 'Agentic Harness');
            refreshWindow();
            renderDebugSection();
        });

        document.getElementById('ah_enabled').checked = s.enabled;
        populateTemplateSelect();
        bindNumberInit('#ah_context', s.contextMessages);
        bindNumberInit('#ah_depth', s.directiveDepth);
        bindNumberInit('#ah_retries', s.retries);
        bindNumberInit('#ah_resplen', s.responseLength);
        syncWindowToggle();
        bindDebugSection();
        renderDebugSection();
    }

    function bindNumberInit(selector, value) {
        const el = document.getElementById(selector.replace(/^#/, ''));
        if (el) el.value = value;
    }

    // -----------------------------------------------------------------------
    // Boot
    // -----------------------------------------------------------------------
    async function init() {
        const context = SillyTavern.getContext();
        extension_settings = context.extension_settings || context.extensionSettings;
        saveSettingsDebounced = context.saveSettingsDebounced;
        BASE_URL = getBaseUrl();

        console.debug('Agentic Harness: initializing');
        extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
        const s = getSettings();

        await loadSettings();
        bindDrawer();

        context.eventSource.on(context.event_types.MESSAGE_RECEIVED, onMessageReceived);
        context.eventSource.on(context.event_types.GENERATION_STOPPED, () => {
            pending = null;
            setDirective('');
        });
        context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
            ensureChatState();
            refreshWindow();
            renderDebugSection();
        });
        for (const ev of [context.event_types.MESSAGE_SWIPED, context.event_types.MESSAGE_DELETED]) {
            context.eventSource.on(ev, refreshWindow);
        }

        if (context.chatId) ensureChatState();
        if (s.windowOpen) setWindowVisible(true);
        renderDebugSection();

        console.log('Agentic Harness extension loaded');
    }

    if (window.SillyTavern) {
        init();
    } else {
        window.addEventListener('DOMContentLoaded', init);
    }
})();
