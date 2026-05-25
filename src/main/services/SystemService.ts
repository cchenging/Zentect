// 📁 路径: src/main/services/SystemService.ts
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { PathManager } from '../utils/pathManager';
import * as fs from 'fs';

export class SystemService {
  private settingsRepo = new SettingsRepository();

  public async getSetting(key: string, defaultValue?: any) {
    return this.settingsRepo.get(key, defaultValue);
  }

  public async setSetting(key: string, value: any) {
    this.settingsRepo.saveSettings({ [key]: value });
  }

  public getPaths() {
    return {
      userData: PathManager.getUserDataPath(),
      projects: PathManager.getProjectsPath(),
      exports: PathManager.getExportRootPath(),
      models: PathManager.getModelsPath(),
      scripts: PathManager.getScriptsPath(),
      logs: PathManager.getLogsPath()
    };
  }

  public async migrateProjects(_oldPath: string, newPath: string) {
    if (!fs.existsSync(newPath)) fs.mkdirSync(newPath, { recursive: true });
    return true;
  }
}
