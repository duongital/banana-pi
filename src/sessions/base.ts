/**
 * base.js
 * Defines the AgentAdapter contract that every agent integration implements.
 *
 * The rest of the app (server + UI) only talks to this interface, so adding a
 * new agent (claude, opencode, ...) is a matter of dropping in a new adapter
 * and registering it in ./index.js — no server or UI changes required.
 */

/**
 * @typedef {Object} ProjectSummary
 * @property {string} id          - Opaque id used in API calls (usually the dir name).
 * @property {string} label       - Human friendly label (e.g. the cwd).
 * @property {number} sessionCount
 * @property {string} [latestTimestamp]
 *
 * @typedef {Object} SessionSummary
 * @property {string} id          - Opaque id used in API calls (base64 file path).
 * @property {string} fileName
 * @property {string} [timestamp]
 * @property {string} [sessionId]
 * @property {string} [sessionName]
 * @property {string} [firstMessage]
 * @property {number} [entryCount]
 * @property {number} [fileSize]
 *
 * @typedef {Object} SearchResult
 * @property {string} id
 * @property {string} fileName
 * @property {string} projectId
 * @property {string} projectLabel
 * @property {'name'|'message'|'content'} matchField
 * @property {string} [timestamp]
 * @property {string} [sessionName]
 * @property {string} [firstMessage]
 */

export class AgentAdapter {
  /** @type {string} stable identifier, e.g. "pi" */
  id = 'base';
  /** @type {string} display name, e.g. "Pi" */
  name = 'Base';

  /** @returns {boolean} whether this agent's data directory exists on disk. */
  isAvailable() {
    return false;
  }

  /** @returns {ProjectSummary[]} */
  listProjects() {
    throw new Error('not implemented');
  }

  /**
   * @param {string} projectId
   * @returns {SessionSummary[]}
   */
  listSessions(projectId) {
    throw new Error('not implemented');
  }

  /**
   * @param {string} sessionId
   * @returns {object} full parsed session
   */
  getSession(sessionId) {
    throw new Error('not implemented');
  }

  /**
   * @param {string} query
   * @param {'meta'|'content'} scope
   * @returns {SearchResult[]}
   */
  search(query, scope) {
    throw new Error('not implemented');
  }

  /** @returns {boolean} whether session files can be modified (writable). */
  canModify() {
    return false;
  }

  /**
   * @param {string} sessionId
   * @returns {{ ok: true }}
   */
  deleteSession(sessionId) {
    throw new Error('not implemented');
  }

  /**
   * @param {string} sessionId
   * @param {string} name
   * @returns {{ ok: true, name: string }}
   */
  renameSession(sessionId, name) {
    throw new Error('not implemented');
  }
}
