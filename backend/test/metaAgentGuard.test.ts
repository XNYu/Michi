import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { META_AGENT_RUNTIMES } from 'michi-shared';
import {
  MetaAgentGuardError, assertMetaAgentToolCatalog, checkMetaAgentToolCatalog, isMetaAgentGuardError, isMetaAgentProfile,
  metaAgentCatalogUnavailable, metaAgentRuntimeAvailability, metaAgentToolsetOf,
} from '../src/agents/metaAgentGuard';
import {
  MAINTENANCE_HISTORY_TOOL_NAMES, MAINTENANCE_READ_WORKSPACE_HOME_TOOL, MAINTENANCE_TOOL_NAMES, META_AGENT_MAINTENANCE_TOOL_NAMES,
  isMaintenanceProfile, maintenanceToolProfile,
} from '../src/agents/maintenancePolicy';
import { LAYOUT_RULES_TOOL, META_AGENT_CHAT_TOOL_NAMES, START_CONVERSATION_TOOL, assistantToolProfile, isAssistantProfile } from '../src/assistant/policy';
import { PAGE_TOOL_NAMES } from '../src/agents/pageToolNames';

describe('checkMetaAgentToolCatalog', () => {
  test('passes when every observed tool is allowed', () => {
    assert.equal(checkMetaAgentToolCatalog({
      runtimeId: 'kiro', toolset: 'maintenance',
      observed: ['maintenance_read_source', 'maintenance_no_change'],
      allowed: ['maintenance_read_source', 'maintenance_no_change', 'maintenance_write_page'],
    }), null);
  });

  test('reports unexpected tools sorted and deduplicated', () => {
    assert.deepEqual(checkMetaAgentToolCatalog({
      runtimeId: 'kiro', toolset: 'chat',
      observed: ['shell', 'read_node', 'fs_write', 'shell'],
      allowed: ['read_node'],
    }), { runtimeId: 'kiro', toolset: 'chat', unexpectedTools: ['fs_write', 'shell'] });
  });

  test('accepts runtime built-ins listed as extra allowed', () => {
    assert.equal(checkMetaAgentToolCatalog({
      runtimeId: 'codex', toolset: 'chat', observed: ['view_image', 'read_node'],
      allowed: ['read_node'], extraAllowed: ['view_image'],
    }), null);
  });

  test('guard errors are recognizable by instance and by code', () => {
    const error = new MetaAgentGuardError({ runtimeId: 'kiro', toolset: 'chat', unexpectedTools: ['shell'] });
    assert.equal(isMetaAgentGuardError(error), true);
    assert.equal(isMetaAgentGuardError({ code: 'meta_agent_guard_failed' }), true);
    assert.equal(isMetaAgentGuardError(new Error('other')), false);
    assert.match(error.message, /kiro: shell/);
  });
});


describe('Meta agent toolsets', () => {
  test('maintenance: the dedicated tools, read-only history and the workspace home reader', () => {
    assert.deepEqual([...META_AGENT_MAINTENANCE_TOOL_NAMES], [
      ...MAINTENANCE_TOOL_NAMES, 'list_threads', 'read_node_overview', 'read_node', 'maintenance_read_workspace_home',
    ]);
    assert.deepEqual([...MAINTENANCE_HISTORY_TOOL_NAMES], ['list_threads', 'read_node_overview', 'read_node']);
    assert.equal(MAINTENANCE_READ_WORKSPACE_HOME_TOOL, 'maintenance_read_workspace_home');
  });

  test('chat: the assistant tools without send_to_thread, plus updates, Pages, layout rules and a new conversation', () => {
    assert.ok(!META_AGENT_CHAT_TOOL_NAMES.includes('send_to_thread'));
    for (const name of ['read_conversation_updates', ...PAGE_TOOL_NAMES, LAYOUT_RULES_TOOL, START_CONVERSATION_TOOL]) {
      assert.ok(META_AGENT_CHAT_TOOL_NAMES.includes(name), name);
    }
    assert.equal(new Set(META_AGENT_CHAT_TOOL_NAMES).size, META_AGENT_CHAT_TOOL_NAMES.length);
  });

  test('neither toolset has a maintenance writer and a chat tool mixed in', () => {
    assert.ok(META_AGENT_CHAT_TOOL_NAMES.every((name) => !name.startsWith('maintenance_')));
    for (const name of ['edit_page', 'ask_user', START_CONVERSATION_TOOL, 'read_conversation_updates', LAYOUT_RULES_TOOL]) {
      assert.ok(!META_AGENT_MAINTENANCE_TOOL_NAMES.includes(name), name);
    }
  });

  test('neither toolset reads or writes Agent Desk', () => {
    for (const list of [META_AGENT_CHAT_TOOL_NAMES, META_AGENT_MAINTENANCE_TOOL_NAMES]) {
      assert.deepEqual(list.filter((name) => name.startsWith('desk_')), []);
    }
  });

  test('profiles carry their toolset; the older markers keep working', () => {
    const maintenance = maintenanceToolProfile();
    const chat = assistantToolProfile();
    assert.equal(metaAgentToolsetOf(maintenance), 'maintenance');
    assert.equal(metaAgentToolsetOf(chat), 'chat');
    assert.ok(isMaintenanceProfile(maintenance) && !isAssistantProfile(maintenance));
    assert.ok(isAssistantProfile(chat) && !isMaintenanceProfile(chat));
    assert.equal(metaAgentToolsetOf({ allowedToolNames: [], maintenance: true }), 'maintenance');
    assert.equal(metaAgentToolsetOf({ allowedToolNames: [], assistant: true }), 'chat');
    assert.equal(metaAgentToolsetOf({ allowedToolNames: ['read'] }), null);
    assert.equal(metaAgentToolsetOf(undefined), null);
    assert.ok(!isMetaAgentProfile({ allowedToolNames: ['read'] }));
  });
});

describe('Meta agent runtime availability', () => {
  test('every configurable runtime but Crew can run both toolsets', () => {
    assert.deepEqual([...META_AGENT_RUNTIMES].sort(), ['claude', 'codex', 'crew', 'kiro', 'pi']);
    for (const id of ['claude', 'pi', 'codex', 'kiro']) assert.deepEqual(metaAgentRuntimeAvailability(id), { available: true }, id);
    const crew = metaAgentRuntimeAvailability('crew');
    assert.equal(crew.available, false);
    assert.match(crew.reason ?? '', /Kiro Crew/);
    assert.equal(metaAgentRuntimeAvailability('other').available, false);
  });
});

describe('assertMetaAgentToolCatalog', () => {
  test('a catalog within the profile passes; one extra tool throws MetaAgentGuardError', () => {
    const profile = maintenanceToolProfile();
    assert.doesNotThrow(() => assertMetaAgentToolCatalog({ runtimeId: 'pi', profile, observed: [...MAINTENANCE_TOOL_NAMES] }));
    assert.throws(
      () => assertMetaAgentToolCatalog({ runtimeId: 'pi', profile, observed: [...MAINTENANCE_TOOL_NAMES, 'bash'] }),
      (error: unknown) => error instanceof MetaAgentGuardError
        && error.violation.toolset === 'maintenance' && error.violation.unexpectedTools.join() === 'bash',
    );
    assert.throws(
      () => assertMetaAgentToolCatalog({ runtimeId: 'codex', profile: assistantToolProfile(), observed: ['send_to_thread'] }),
      MetaAgentGuardError,
      'a chat session may not have send_to_thread',
    );
  });

  test('extraAllowed admits the runtime\'s documented built-ins only', () => {
    const profile = assistantToolProfile();
    assert.doesNotThrow(() => assertMetaAgentToolCatalog({ runtimeId: 'codex', profile, observed: ['view_image'], extraAllowed: ['view_image'] }));
    assert.throws(() => assertMetaAgentToolCatalog({ runtimeId: 'codex', profile, observed: ['view_image'] }), MetaAgentGuardError);
  });

  test('an ordinary profile is a programming error, not a pass', () => {
    assert.throws(() => assertMetaAgentToolCatalog({ runtimeId: 'pi', profile: { allowedToolNames: ['read'] }, observed: [] }),
      (error: unknown) => error instanceof Error && !isMetaAgentGuardError(error));
  });

  test('a runtime that never reports its catalog fails with the guard code', () => {
    const error = metaAgentCatalogUnavailable('kiro', 'chat', 'no tool catalog within 10s');
    assert.ok(isMetaAgentGuardError(error));
    assert.deepEqual(error.violation, { runtimeId: 'kiro', toolset: 'chat', unexpectedTools: [], detail: 'no tool catalog within 10s' });
    assert.match(error.message, /kiro \(no tool catalog within 10s\)/);
  });
});
