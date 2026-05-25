// 📁 路径: src/shared/utils/Validator.ts

export const Validator = {
  /**
   * 严谨的项目名称校验规则
   * @returns { valid: boolean; errorKey?: string } 带有国际化错误键的校验结果
   */
  validateProjectName: (name: string): { valid: boolean; errorKey?: string } => {
    if (!name || name.trim() === '') {
      return { valid: false, errorKey: 'errors.PROJECT_NAME_EMPTY' }; // 不能为空
    }
    
    if (name.length > 50) {
      return { valid: false, errorKey: 'errors.PROJECT_NAME_TOO_LONG' }; // 限制长度防爆库
    }
    
    // Windows & Mac 核心非法路径字符拦截
    const illegalChars = /[<>:"/\\|?*\x00-\x1F]/;
    if (illegalChars.test(name)) {
      return { valid: false, errorKey: 'errors.PROJECT_NAME_ILLEGAL_CHARS' };
    }
    
    return { valid: true };
  },

  /**
   * 清洗文件名，用于生成安全的底层文件夹名称
   */
  sanitizeForPath: (name: string): string => {
    return name.replace(/[<>:"/\\|?*\x00-\x1F\s]/g, '_');
  }
};
