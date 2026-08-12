const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

class ConfigLoader {
  constructor() {
    this.agents = [];
    this.git = {};
    this.users = [];
    this.taskDefaults = {};
    this.apiKeys = {};
  }

  loadAll() {
    this.agents = this._loadYaml('config/agents.yaml').agents || [];
    this.git = this._loadYaml('config/git.yaml').git || {};
    this.users = this._loadYaml('config/users.yaml').users || [];
    this.taskDefaults = this._loadYaml('config/task_defaults.yaml').task_defaults || {};
    this.apiKeys = this._loadYaml('config/api_keys.yaml').api_keys || {};
    return this;
  }

  _loadYaml(relativePath) {
    const fullPath = path.join(ROOT, relativePath);
    if (!fs.existsSync(fullPath)) {
      console.error(`[ConfigLoader] File not found: ${fullPath}`);
      return {};
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    return yaml.load(content) || {};
  }

  getDefaultAgent() {
    return this.agents.find(a => a.default) || this.agents[0] || null;
  }

  getAgentByName(name) {
    return this.agents.find(a => a.name === name) || null;
  }

  getAgentByCli(cli) {
    return this.agents.find(a => a.model_cli === cli) || null;
  }

  getUserById(userId) {
    return this.users.find(u => u.id === userId) || null;
  }

  isAdmin(userId) {
    const user = this.getUserById(userId);
    return user && user.role === 'admin';
  }
}

module.exports = new ConfigLoader();
