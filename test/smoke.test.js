const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT_DIR = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(EXT_DIR, 'index.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(EXT_DIR, 'settings.html'), 'utf8');

// --- DOM -------------------------------------------------------------------
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="extensions_settings"></div></body></html>', {
    url: 'http://localhost/',
});
const { window } = dom;

// --- ST context stub -------------------------------------------------------
const promptCalls = [];
const eventHandlers = {};
let generateRawImpl = async () => { throw new Error('not stubbed'); };
let generateRawCalls = 0;
let lastGenOpts = null;

const chat = [
    { is_user: false, name: 'Guard', mes: 'The guard eyes you from the doorway.' },
    { is_user: true, name: 'Me', mes: 'I hand him a gold coin and ask about the cellar.' },
];

const ctxStub = {
    extension_settings: {},
    saveSettingsDebounced() {},
    eventSource: { on: (ev, fn) => { (eventHandlers[ev] ??= []).push(fn); } },
    event_types: {
        MESSAGE_RECEIVED: 'message_received',
        GENERATION_STOPPED: 'generation_stopped',
        CHAT_CHANGED: 'chat_loaded',
        MESSAGE_SWIPED: 'message_swiped',
        MESSAGE_DELETED: 'message_deleted',
    },
    chatMetadata: {},
    chatId: 'chat1',
    groupId: null,
    characterId: 0,
    chat,
    async saveMetadata() { this._metaSaved = (this._metaSaved || 0) + 1; },
    async saveChat() { this._chatSaved = (this._chatSaved || 0) + 1; },
    setExtensionPrompt(key, value, position, depth, scan, role) {
        promptCalls.push({ key, value, position, depth, role });
    },
    async generateRaw(opts) { generateRawCalls++; lastGenOpts = opts; return generateRawImpl(opts); },
};

// --- globals for index.js --------------------------------------------------
global.window = window;
global.document = window.document;
window.SillyTavern = { getContext: () => ctxStub };
global.SillyTavern = window.SillyTavern;
global.jQuery = require('jquery'); // auto-binds to global.document (the jsdom one)
global.fetch = async (url) => {
    if (String(url).endsWith('settings.html')) return { ok: true, text: async () => settingsHtml };
    throw new Error('unexpected fetch: ' + url);
};

let failures = 0;
function check(name, cond, extra) {
    if (cond) console.log(`  PASS  ${name}`);
    else { failures++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

async function main() {
    // Load extension (init runs synchronously since window.SillyTavern exists)
    (0, eval)(indexSrc);
    await new Promise((r) => setTimeout(r, 20));

    const interceptor = globalThis.agenticHarnessInterceptor;
    check('interceptor registered on globalThis', typeof interceptor === 'function');
    check('settings drawer mounted', !!window.document.getElementById('ah_enabled'));
    check('template select populated', window.document.getElementById('ah_template').options.length === 3);
    const ctxVal = window.document.getElementById('ah_context').value;
    check('context input initialised', ctxVal === '6', `got ${JSON.stringify(ctxVal)}, settings=${JSON.stringify(ctxStub.extension_settings.agentic_harness)}`);
    check('per-chat schema initialised', Array.isArray(ctxStub.chatMetadata.agentic_harness?.schema));
    check('baseline from schema initials', ctxStub.chatMetadata.agentic_harness?.baseline?.npc_disposition?.trust_level === 5);

    // --- Turn 1: successful Director run -------------------------------------
    generateRawImpl = async () => JSON.stringify({
        state_mutations: {
            'npc_disposition.trust_level': -2,
            'plot_flags.current_topic': 'cellar_key',
            'not.a.real.key': 1,
        },
        narrative_directives: 'The guard grows suspicious and mentions a cellar door key.',
    });

    promptCalls.length = 0;
    await interceptor(chat, 8000, () => {}, 'normal');

    check('generateRaw called once', generateRawCalls === 1, `got ${generateRawCalls}`);
    const lastPromptCall = promptCalls[promptCalls.length - 1];
    check('directive injected', promptCalls.some((c) => c.key === 'agentic_harness_directive' && c.value.includes("Director's note")));
    check('directive position IN_CHAT=1, role SYSTEM=0', lastPromptCall?.position === 1 && lastPromptCall?.role === 0,
        JSON.stringify(lastPromptCall));
    check('director prompt carries schema description',
        String(lastGenOpts?.systemPrompt).includes('send a delta') && String(lastGenOpts?.systemPrompt).includes('trust_level'),
        String(lastGenOpts?.systemPrompt).slice(0, 200));
    check('director prompt carries state + transcript',
        String(lastGenOpts?.prompt).includes('Current state') && String(lastGenOpts?.prompt).includes('gold coin'));

    // --- MESSAGE_RECEIVED attaches snapshot ----------------------------------
    (eventHandlers['message_received'] ?? []).forEach((fn) => fn(2, 'normal'));
    await new Promise((r) => setTimeout(r, 10));

    // chat only has 2 messages (index 0,1) — handler should have bailed gracefully on invalid index
    chat.push({ is_user: false, name: 'Guard', mes: 'He lowers his voice.' });
    // Re-run a director turn so pending exists, then deliver at index 2
    await interceptor(chat, 8000, () => {}, 'normal');
    (eventHandlers['message_received'] ?? []).forEach((fn) => fn(2, 'normal'));
    await new Promise((r) => setTimeout(r, 10));

    const ah = chat[2].extra?.ah;
    check('snapshot attached to AI message', !!ah);
    check('trust_level delta applied (5 - 2 = 3)', ah?.state?.npc_disposition?.trust_level === 3, `got ${ah?.state?.npc_disposition?.trust_level}`);
    check('enum/text mutation applied', ah?.state?.plot_flags?.current_topic === 'cellar_key');
    check('unknown key rejected', ah?.rejected?.['not.a.real.key'] === 'unknown key', JSON.stringify(ah?.rejected));
    check('directives stored', typeof ah?.directives === 'string' && ah.directives.length > 0);
    check('directive cleared after reply', promptCalls[promptCalls.length - 1]?.value === '');

    // --- getBaseState: snapshot before last user message ---------------------
    // chat: [0 ai, 1 user, 2 ai(+snapshot)]  -> append user msg, base should be snapshot at 2
    chat.push({ is_user: true, name: 'Me', mes: 'I follow up.' });
    generateRawImpl = async () => JSON.stringify({ state_mutations: { 'npc_disposition.trust_level': 1 }, narrative_directives: 'x' });
    await interceptor(chat, 8000, () => {}, 'normal');
    (eventHandlers['message_received'] ?? []).forEach((fn) => fn(2, 'normal'));
    await new Promise((r) => setTimeout(r, 10));
    const ah2 = chat[2].extra.ah;
    check('base state came from prior snapshot (3 + 1 = 4)', ah2.state.npc_disposition.trust_level === 4,
        `got ${ah2.state.npc_disposition.trust_level}; applied=${JSON.stringify(ah2.applied)} rejected=${JSON.stringify(ah2.rejected)}; directives=${JSON.stringify(ah2.directives)}; chatLen=${chat.length}`);

    // --- Fail open -----------------------------------------------------------
    promptCalls.length = 0;
    generateRawImpl = async () => { throw new Error('API down'); };
    let threw = false;
    try { await interceptor(chat, 8000, () => {}, 'normal'); } catch { threw = true; }
    check('fail-open: no throw when Director fails', !threw);
    check('fail-open: no directive injected', !promptCalls.some((c) => c.value.includes("Director's note")));

    // --- Bad JSON retry ------------------------------------------------------
    generateRawCalls = 0;
    generateRawImpl = async () => 'not json at all';
    threw = false;
    try { await interceptor(chat, 8000, () => {}, 'normal'); } catch { threw = true; }
    check('bad JSON: retried (1 + 1 retries = 2 calls)', generateRawCalls === 2, `got ${generateRawCalls}`);
    check('bad JSON: fail-open after retries', !threw);

    // --- Gates ----------------------------------------------------------------
    generateRawCalls = 0;
    generateRawImpl = async () => JSON.stringify({ state_mutations: {}, narrative_directives: '' });
    await interceptor(chat, 8000, () => {}, 'quiet');
    await interceptor(chat, 8000, () => {}, 'impersonate');
    check('quiet/impersonate skipped', generateRawCalls === 0, `got ${generateRawCalls}`);
    ctxStub.groupId = 'grp1';
    await interceptor(chat, 8000, () => {}, 'normal');
    check('group chats skipped', generateRawCalls === 0, `got ${generateRawCalls}`);
    ctxStub.groupId = null;

    // --- Window: open + schema editor + state editor + log --------------------
    const doc = window.document;
    doc.getElementById('ah_open_window').checked = true;
    global.jQuery('#ah_open_window').trigger('change');
    await new Promise((r) => setTimeout(r, 10));
    check('window created and visible', !!doc.getElementById('ah-window') && !doc.getElementById('ah-window').classList.contains('is-hidden'));
    check('log rendered with snapshot entry', doc.getElementById('ah-win-log').textContent.includes('message #2'));

    // invalid schema rejected
    doc.getElementById('ah-win-schema').value = JSON.stringify([{ path: 'bad path!', type: 'counter' }]);
    doc.getElementById('ah-win-schema-apply').click();
    await new Promise((r) => setTimeout(r, 10));
    check('invalid schema rejected', doc.getElementById('ah-win-status').classList.contains('ah-err'),
        doc.getElementById('ah-win-status').textContent);

    // valid schema applied + baseline reconciled
    const newSchema = [
        { path: 'npc_disposition.trust_level', type: 'counter', initial: 5, min: 0, max: 10, maxStep: 2, description: 'trust' },
        { path: 'plot_flags.new_flag', type: 'flag', initial: false, description: 'a new flag' },
    ];
    doc.getElementById('ah-win-schema').value = JSON.stringify(newSchema);
    doc.getElementById('ah-win-schema-apply').click();
    await new Promise((r) => setTimeout(r, 10));
    check('valid schema applied', doc.getElementById('ah-win-status').classList.contains('ah-ok'),
        doc.getElementById('ah-win-status').textContent);
    check('schema stored per chat', ctxStub.chatMetadata.agentic_harness.schema.length === 2);
    check('baseline reconciled with new field', ctxStub.chatMetadata.agentic_harness.baseline.plot_flags.new_flag === false);
    check('baseline preserved existing value', ctxStub.chatMetadata.agentic_harness.baseline.npc_disposition.trust_level === 5,
        JSON.stringify(ctxStub.chatMetadata.agentic_harness.baseline));

    // state editor patches the newest snapshot
    doc.getElementById('ah-win-state').value = JSON.stringify({ npc_disposition: { trust_level: 7 }, plot_flags: { new_flag: true } });
    doc.getElementById('ah-win-state-apply').click();
    await new Promise((r) => setTimeout(r, 10));
    check('state applied to newest snapshot', chat[2].extra.ah.state.npc_disposition.trust_level === 7,
        JSON.stringify(chat[2].extra.ah.state));
    check('state editor reports ok', doc.getElementById('ah-win-status').classList.contains('ah-ok'));

    // invalid state JSON rejected
    doc.getElementById('ah-win-state').value = '{oops';
    doc.getElementById('ah-win-state-apply').click();
    await new Promise((r) => setTimeout(r, 10));
    check('invalid state JSON rejected', doc.getElementById('ah-win-status').classList.contains('ah-err'));

    // --- Debugging Mode: Prompts and Templates --------------------------------
    check('debug content hidden by default', doc.getElementById('ah_debug_content').hidden === true);
    doc.getElementById('ah_debug_enabled').checked = true;
    global.jQuery('#ah_debug_enabled').trigger('change');
    await new Promise((r) => setTimeout(r, 10));
    check('debug mode enabled shows content', doc.getElementById('ah_debug_content').hidden === false);
    check('debug mode persisted', ctxStub.extension_settings.agentic_harness.debugMode === true);

    // A successful real turn so the "Last executed run" panel shows an OK run
    // (generateRawImpl is already a valid stub from the gates section)
    await interceptor(chat, 8000, () => {}, 'normal');
    (eventHandlers['message_received'] ?? []).forEach((fn) => fn(2, 'normal'));
    await new Promise((r) => setTimeout(r, 10));

    check('system template editor prefilled with default',
        doc.getElementById('ah_dbg_sys_tpl').value.includes('You are the Game Master'));
    check('user template editor prefilled with default',
        doc.getElementById('ah_dbg_user_tpl').value.includes('{{state}}'));
    check('wrapper editor prefilled with default',
        doc.getElementById('ah_dbg_wrap_tpl').value.includes('{{directive}}'));
    check('live system preview rendered', doc.getElementById('ah_dbg_sys_live').value.includes('trust_level'),
        doc.getElementById('ah_dbg_sys_live').value.slice(0, 120));
    check('live user preview rendered', doc.getElementById('ah_dbg_user_live').value.includes('# Recent chat')
        && doc.getElementById('ah_dbg_user_live').value.includes('# Current state'));
    check('built-in templates shown (3)', doc.getElementById('ah_dbg_tpl_relationship').value.includes('"npc_disposition.trust_level"')
        && doc.getElementById('ah_dbg_tpl_dungeon').value.includes('"party.health"')
        && doc.getElementById('ah_dbg_tpl_mystery').value.includes('"case.clues_found"'));
    check('last-run meta shows OK run', doc.getElementById('ah_dbg_last_meta').textContent.includes('OK'),
        doc.getElementById('ah_dbg_last_meta').textContent);
    check('last-run system prompt shown', doc.getElementById('ah_dbg_sys_last').value.includes('Game Master'),
        `len=${doc.getElementById('ah_dbg_sys_last').value.length} head=${JSON.stringify(doc.getElementById('ah_dbg_sys_last').value.slice(0, 120))} meta=${JSON.stringify(doc.getElementById('ah_dbg_last_meta').textContent)}`);
    check('last-run prompt captured in extra.ah', typeof chat[2].extra.ah.director_sys_prompt === 'string'
        && typeof chat[2].extra.ah.director_user_prompt === 'string');

    // Editable system template: apply
    doc.getElementById('ah_dbg_sys_tpl').value = 'CUSTOM SYSTEM {{fields}}';
    doc.getElementById('ah_dbg_sys_apply').click();
    await new Promise((r) => setTimeout(r, 10));
    check('system template override persisted', ctxStub.extension_settings.agentic_harness.directorSystemTemplate === 'CUSTOM SYSTEM {{fields}}');
    check('live preview uses override', doc.getElementById('ah_dbg_sys_live').value.startsWith('CUSTOM SYSTEM'),
        doc.getElementById('ah_dbg_sys_live').value.slice(0, 80));
    check('template applied status ok', doc.getElementById('ah_dbg_status').classList.contains('ah-ok'));

    // Missing placeholder -> warning
    doc.getElementById('ah_dbg_sys_tpl').value = 'no placeholders here';
    doc.getElementById('ah_dbg_sys_apply').click();
    await new Promise((r) => setTimeout(r, 10));
    check('missing placeholder warns', doc.getElementById('ah_dbg_status').classList.contains('ah-warn'),
        doc.getElementById('ah_dbg_status').textContent);

    // Reset
    doc.getElementById('ah_dbg_sys_reset').click();
    await new Promise((r) => setTimeout(r, 10));
    check('reset clears override', ctxStub.extension_settings.agentic_harness.directorSystemTemplate === null);
    check('reset restores default text', doc.getElementById('ah_dbg_sys_tpl').value.includes('You are the Game Master'));

    // Test Director dry run — must have zero side effects
    const promptCountBeforeTest = promptCalls.length;
    const metaSavedBefore = ctxStub._metaSaved;
    const snapshotStateBefore = JSON.stringify(chat[2].extra.ah.state);
    generateRawImpl = async () => JSON.stringify({
        state_mutations: { 'plot_flags.new_flag': true },
        narrative_directives: 'dry run directive',
    });
    doc.getElementById('ah_dbg_test').click();
    await new Promise((r) => setTimeout(r, 30));
    check('Test Director reports ok', doc.getElementById('ah_dbg_status').classList.contains('ah-ok'),
        doc.getElementById('ah_dbg_status').textContent);
    check('Test Director shows WOULD APPLY output', doc.getElementById('ah_dbg_test_out').value.includes('WOULD APPLY'));
    check('Test Director shows directive preview', doc.getElementById('ah_dbg_test_out').value.includes('dry run directive'));
    check('Test Director injected nothing', promptCalls.length === promptCountBeforeTest,
        `promptCalls ${promptCountBeforeTest} -> ${promptCalls.length}`);
    check('Test Director saved no state', JSON.stringify(chat[2].extra.ah.state) === snapshotStateBefore
        && ctxStub._metaSaved === metaSavedBefore);

    // Directive wrapper override affects injection
    doc.getElementById('ah_dbg_wrap_tpl').value = '[WRAP {{directive}}]';
    doc.getElementById('ah_dbg_wrap_apply').click();
    await new Promise((r) => setTimeout(r, 10));
    generateRawImpl = async () => JSON.stringify({ state_mutations: {}, narrative_directives: 'wrap-me' });
    await interceptor(chat, 8000, () => {}, 'normal');
    check('custom wrapper used for injection',
        promptCalls[promptCalls.length - 1]?.value === '[WRAP wrap-me]',
        JSON.stringify(promptCalls[promptCalls.length - 1]));
    (eventHandlers['message_received'] ?? []).forEach((fn) => fn(2, 'normal'));
    await new Promise((r) => setTimeout(r, 10));
    // restore default wrapper
    doc.getElementById('ah_dbg_wrap_reset').click();

    // --- Template loading ------------------------------------------------------
    global.confirm = () => true;
    doc.getElementById('ah_template').value = 'dungeon';
    global.jQuery('#ah_template_apply').trigger('click');
    await new Promise((r) => setTimeout(r, 10));
    check('template loaded: schema swapped', ctxStub.chatMetadata.agentic_harness.schema.some((f) => f.path === 'party.health'));
    check('template loaded: baseline reinitialised', ctxStub.chatMetadata.agentic_harness.baseline.party?.health === 10,
        JSON.stringify(ctxStub.chatMetadata.agentic_harness.baseline));
    check('template stored as default', ctxStub.extension_settings.agentic_harness.defaultTemplate === 'dungeon');
    // guard: template must still gate mutations (old paths no longer valid)
    generateRawImpl = async () => JSON.stringify({ state_mutations: { 'npc_disposition.trust_level': 5 }, narrative_directives: '' });
    await interceptor(chat, 8000, () => {}, 'normal');
    (eventHandlers['message_received'] ?? []).forEach((fn) => fn(2, 'normal'));
    await new Promise((r) => setTimeout(r, 10));
    const ah3 = chat[2].extra.ah;
    check('old schema path rejected after template swap', ah3.rejected['npc_disposition.trust_level'] === 'unknown key',
        JSON.stringify(ah3.rejected));

    console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
