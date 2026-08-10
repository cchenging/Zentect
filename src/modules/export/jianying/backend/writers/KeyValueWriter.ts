// 📁 路径：src/modules/export/jianying/backend/writers/KeyValueWriter.ts
// key_value.json 写入：剪映 8.9.0+ "本地"素材面板显示的关键文件（手册坑位 7/8）

/**
 * 构建 key_value.json 对象。
 *
 * 结构：以 material.id 为 key 的"素材注册"条目（38 字段，无 segmentId）+ 以 segment.id 为 key 的
 * "片段引用"条目（24 字段，含 segmentId）。所有 33 个非业务字段保持模板默认值，缺一都会导致面板不显示。
 *
 * @param content 已编译的 draft_content 对象
 * @returns key_value.json 对象
 */
export function buildKeyValue(content: Record<string, unknown>): Record<string, unknown> {
  const materials = (content.materials as any) || {};
  const tracks = (content.tracks as any[]) || [];
  const result: Record<string, unknown> = {};

  /** 素材注册条目：业务必填 5 字段，其余 33 字段保持模板默认值（手册 §6.1） */
  const registerEntry = (mat: any): Record<string, unknown> => {
    const name = mat.name || mat.material_name || '';
    return {
      commerce_template_cate: '',
      commerce_template_pay_status: '',
      commerce_template_pay_type: '',
      enter_from: '',
      filter_category: '',
      filter_detail: '',
      is_brand: 0,
      is_from_artist_shop: 0,
      is_limited: false,
      is_vip: '0',
      keywordSource: '',
      materialCategory: 'media',
      materialId: mat.id,
      materialName: name,
      materialSubcategory: 'local',
      materialSubcategoryId: '',
      materialThirdcategory: '导入',
      materialThirdcategoryId: '',
      material_copyright: '',
      material_is_purchased: '',
      previewed: 0,
      previewed_before_added: 0,
      rank: '0',
      rec_id: '',
      requestId: '',
      role: '',
      searchId: '',
      searchKeyword: '',
      special_effect_loading_type: '',
      team_id: '',
      template_author_id: '',
      template_drafts_price: 0,
      template_duration: 0,
      template_fragment_cnt: 0,
      template_need_purcahse: true,
      template_type: '',
      template_use_cnt: 0,
      textTemplateVersion: '',
    };
  };

  /** 片段引用条目：在注册基础上额外添加 segmentId（手册 §6.2，仅保留 24 字段子集） */
  const segmentEntry = (mat: any, segmentId: string): Record<string, unknown> => {
    const base = registerEntry(mat);
    const subset: Record<string, unknown> = {};
    for (const key of [
      'filter_category', 'filter_detail', 'is_brand', 'is_from_artist_shop', 'is_vip',
      'keywordSource', 'materialCategory', 'materialId', 'materialName', 'materialSubcategory',
      'materialSubcategoryId', 'materialThirdcategory', 'materialThirdcategoryId',
      'material_copyright', 'material_is_purchased', 'rank', 'rec_id', 'requestId', 'role',
      'searchId', 'searchKeyword', 'segmentId', 'team_id', 'textTemplateVersion',
    ]) {
      if (key === 'segmentId') subset[key] = segmentId;
      else subset[key] = base[key];
    }
    return subset;
  };

  // 收集 video / audio / text 三类素材，按 id 索引
  const matById = new Map<string, any>();
  for (const cat of ['videos', 'audios', 'texts']) {
    for (const mat of (materials[cat] as any[]) || []) {
      if (mat && mat.id) matById.set(mat.id, mat);
    }
  }

  // 每个素材生成一条注册条目
  for (const mat of matById.values()) {
    result[mat.id] = registerEntry(mat);
  }

  // 每个 segment 生成一条片段引用条目（segment + 其引用的素材）
  for (const track of tracks) {
    for (const seg of (track.segments as any[]) || []) {
      if (!seg || !seg.id) continue;
      const mat = matById.get(seg.material_id);
      if (mat) result[seg.id] = segmentEntry(mat, seg.id);
    }
  }

  return result;
}