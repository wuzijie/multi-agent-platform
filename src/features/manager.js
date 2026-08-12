const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * 特性清单系统
 *
 * 管理 features/ 目录下的特性清单文件
 * 每个特性一个 .md 文件，INDEX.md 维护总索引
 */
class FeatureManager {
  constructor() {
    this.featuresDir = path.join(ROOT, 'features');
    this._ensureDir();
    this._ensureIndex();
  }

  _ensureDir() {
    if (!fs.existsSync(this.featuresDir)) {
      fs.mkdirSync(this.featuresDir, { recursive: true });
    }
  }

  _ensureIndex() {
    const indexPath = path.join(this.featuresDir, 'INDEX.md');
    if (!fs.existsSync(indexPath)) {
      const content = `# 特性清单索引\n\n| 编号 | 特性名称 | 状态 | 关联任务 | 最后更新 |\n|------|----------|------|----------|----------|\n| feat_001 | 项目初始化 | 规划中 | — | ${new Date().toISOString().split('T')[0]} |\n`;
      fs.writeFileSync(indexPath, content);
    }
  }

  /**
   * 创建新特性
   */
  createFeature(name, description, associatedTask = null) {
    // 获取下一个编号
    const existing = this.listFeatures();
    const nextNum = String(existing.length + 1).padStart(3, '0');
    const featureId = `feat_${nextNum}`;

    const now = new Date().toISOString().split('T')[0];
    const content = `# ${name}

- **描述**：${description}
- **状态**：规划中
- **开发进度描述**：特性已创建，等待启动开发
- **关联任务**：${associatedTask || '—'}
- **创建时间**：${now}
- **最后更新**：${now}
`;

    const filePath = path.join(this.featuresDir, `${featureId}.md`);
    fs.writeFileSync(filePath, content);

    // 更新索引
    this._updateIndex(featureId, name, '规划中', associatedTask || '—', now);

    return { featureId, name, filePath };
  }

  /**
   * 更新特征状态
   */
  updateFeature(featureId, updates = {}) {
    const filePath = path.join(this.featuresDir, `${featureId}.md`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Feature not found: ${featureId}`);
    }

    let content = fs.readFileSync(filePath, 'utf8');
    const now = new Date().toISOString().split('T')[0];

    if (updates.status !== undefined) {
      content = content.replace(/- \*\*状态\*\*：.*$/m, `- **状态**：${updates.status}`);
    }
    if (updates.progress !== undefined) {
      content = content.replace(/- \*\*开发进度描述\*\*：.*$/m, `- **开发进度描述**：${updates.progress}`);
    }
    if (updates.associatedTask !== undefined) {
      content = content.replace(/- \*\*关联任务\*\*：.*$/m, `- **关联任务**：${updates.associatedTask}`);
    }
    // 始终更新最后更新时间
    content = content.replace(/- \*\*最后更新\*\*：.*$/m, `- **最后更新**：${now}`);

    fs.writeFileSync(filePath, content);

    // 更新索引
    const featureData = this._parseFeature(featureId);
    if (featureData) {
      this._updateIndex(featureId, featureData.name, featureData.status, featureData.associatedTask, now);
    }

    return this.getFeature(featureId);
  }

  /**
   * 获取单个特性
   */
  getFeature(featureId) {
    const filePath = path.join(this.featuresDir, `${featureId}.md`);
    if (!fs.existsSync(filePath)) return null;
    return this._parseFeature(featureId);
  }

  /**
   * 解析特性文件
   */
  _parseFeature(featureId) {
    const filePath = path.join(this.featuresDir, `${featureId}.md`);
    if (!fs.existsSync(filePath)) return null;

    const content = fs.readFileSync(filePath, 'utf8');
    const name = content.match(/^# (.+)$/m)?.[1] || featureId;
    const desc = content.match(/- \*\*描述\*\*：(.*)$/m)?.[1]?.trim() || '';
    const status = content.match(/- \*\*状态\*\*：(.*)$/m)?.[1]?.trim() || '规划中';
    const progress = content.match(/- \*\*开发进度描述\*\*：(.*)$/m)?.[1]?.trim() || '';
    const associatedTask = content.match(/- \*\*关联任务\*\*：(.*)$/m)?.[1]?.trim() || '—';
    const createdAt = content.match(/- \*\*创建时间\*\*：(.*)$/m)?.[1]?.trim() || '';
    const updatedAt = content.match(/- \*\*最后更新\*\*：(.*)$/m)?.[1]?.trim() || '';

    return {
      featureId,
      name,
      description: desc,
      status,
      progress,
      associatedTask,
      created_at: createdAt,
      updated_at: updatedAt,
    };
  }

  /**
   * 列出所有特性
   */
  listFeatures(filter = {}) {
    this._ensureDir();
    const files = fs.readdirSync(this.featuresDir)
      .filter(f => f.endsWith('.md') && f !== 'INDEX.md');

    const features = [];
    for (const file of files) {
      const featureId = file.replace('.md', '');
      const feature = this._parseFeature(featureId);
      if (feature) features.push(feature);
    }

    let filtered = features;
    if (filter.status) {
      filtered = filtered.filter(f => f.status === filter.status);
    }

    return filtered;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const features = this.listFeatures();
    const stats = { total: features.length, by_status: {} };
    for (const f of features) {
      stats.by_status[f.status] = (stats.by_status[f.status] || 0) + 1;
    }
    return stats;
  }

  /**
   * 读取 INDEX.md 原始内容
   */
  getIndexContent() {
    const indexPath = path.join(this.featuresDir, 'INDEX.md');
    return fs.readFileSync(indexPath, 'utf8');
  }

  /**
   * 更新索引文件
   */
  _updateIndex(featureId, name, status, associatedTask, updatedAt) {
    const indexPath = path.join(this.featuresDir, 'INDEX.md');
    let content = fs.readFileSync(indexPath, 'utf8');

    // 检查是否已存在该条目的行
    const lineStart = content.indexOf(`| ${featureId} `);
    const newLine = `| ${featureId} | ${name} | ${status} | ${associatedTask} | ${updatedAt} |`;

    if (lineStart >= 0) {
      // 替换已有行
      const lineEnd = content.indexOf('\n', lineStart);
      content = content.substring(0, lineStart) + newLine + content.substring(lineEnd);
    } else {
      // 追加新行
      content = content.trimEnd() + '\n' + newLine + '\n';
    }

    fs.writeFileSync(indexPath, content);
  }
}

module.exports = new FeatureManager();
