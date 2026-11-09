import { transitionOptions } from './storyboard-enums';
import { isPlaceholderEmptyDialogue, parseGenMode } from './storyboard-text';

/** Nested storyboard edits never replace sibling shots or server-managed media fields. */
export function patchStoryboardScene(scenes: any[], sceneIdx: number, shotIdx: number | undefined, body: unknown) {
  if (!Number.isSafeInteger(sceneIdx) || sceneIdx < 0 || !scenes[sceneIdx] || !Array.isArray(scenes[sceneIdx].shots)) {
    throw new Error('场景不存在或不是新版分镜结构');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('修改内容必须为对象');
  const fields = shotIdx === undefined
    ? ['scene_id', 'prop_ids', 'environment', 'transition', 'bgm']
    : ['shot_size', 'camera_angle', 'camera_movement', 'content', 'dialogue', 'sound_effect',
      'roles', 'durShort', 'videoPrompt', 'start_prompt', 'end_prompt', 'negative_prompt',
      'subject_motion', 'key_prop_action', 'axis_side', 'eyeline', 'link', 'motion', 'continuity',
      'frame_mode', 'world_state',
      // 镜头级切换方式：本镜 → 下一镜（为空时合成按"跨场景用场景 transition、同场景硬切"兜底）
      'transition', 'transition_out',
      // ★ LibTV 对标新增 11 个分镜表字段
      'plot_description', 'image_prompt', 'motion_prompt', 'scene_tags', 'lighting',
      'emotion', 'character_action', 'character_refs', 'reference_frame_url', 'gen_mode', 'model_params'];
  const patch: Record<string, any> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!fields.includes(key)) throw new Error(`不支持修改字段：${key}`);
    if ((key === 'transition' || key === 'transition_out') && value !== '' && !transitionOptions.includes(value as string)) {
      throw new Error('请选择有效的镜头切换方式');
    }
    if (key === 'frame_mode' && !['single', 'dual', 'video_tail'].includes(String(value))) {
      throw new Error('无效的关键帧模式');
    }
    if (key === 'gen_mode') {
      if (value === '' || value === null || value === undefined) {
        patch.gen_mode = undefined;
        continue;
      }
      const mode = parseGenMode(value);
      if (!mode) throw new Error(`无效的视频生成模式：${String(value)}`);
      patch.gen_mode = mode;
      continue;
    }
    if (key === 'character_refs') {
      if (!Array.isArray(value)) throw new Error('character_refs 必须为数组');
      patch.character_refs = value
        .filter((item: any) => item && typeof item === 'object')
        .map((item: any) => ({
          role_id: String(item.role_id ?? item.id ?? '').trim(),
          name: String(item.name ?? '').trim(),
          description: String(item.description ?? '').trim(),
          ...(item.image_url ? { image_url: String(item.image_url).trim() } : {}),
        }));
      continue;
    }
    if (key === 'model_params') {
      if (value !== null && value !== undefined && (typeof value !== 'object' || Array.isArray(value))) {
        throw new Error('model_params 必须为对象');
      }
      patch.model_params = value ? { ...value } : undefined;
      continue;
    }
    if (key === 'scene_tags') {
      if (Array.isArray(value)) {
        patch.scene_tags = value.map(v => String(v ?? '').trim()).filter(Boolean).join(',');
        continue;
      }
      if (value === null || value === undefined) {
        patch.scene_tags = '';
        continue;
      }
      if (typeof value !== 'string') {
        throw new Error('scene_tags 必须为字符串');
      }
      patch.scene_tags = value;
      continue;
    }
    if (!['scene_id', 'prop_ids', 'dialogue', 'roles', 'durShort', 'link', 'motion', 'continuity', 'character_refs', 'model_params', 'gen_mode', 'scene_tags'].includes(key) && typeof value !== 'string') {
      throw new Error(`${key} 必须为字符串`);
    }
    if (key === 'durShort' && (typeof value !== 'number' || !Number.isInteger(value) || value < 2 || value > 15)) {
      throw new Error('视频时长必须是 2 到 15 秒的整数');
    }
    if (key === 'roles') {
      if (!Array.isArray(value)) throw new Error('出镜角色无效');
      patch.roles = value.map(role => {
        const id = typeof role?.id === 'string' && /^\d+$/.test(role.id) ? Number(role.id) : role?.id;
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('出镜角色无效');
        return { ...role, id };
      });
      continue;
    }
    if (key === 'link' || key === 'motion' || key === 'continuity') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} 必须为对象`);
      patch[key] = { ...value };
      continue;
    }
    patch[key] = value;
    if (key === 'transition_out' && shotIdx !== undefined) patch.transition = value;
    if (key === 'transition' && shotIdx !== undefined) patch.transition_out = value;
  }
  if (!Object.keys(patch).length) throw new Error('没有可更新的字段');
  if (patch.dialogue !== undefined) {
    if (!Array.isArray(patch.dialogue)) throw new Error('对白必须为数组');
    patch.dialogue = patch.dialogue.map((line: any) => {
      if (!line || typeof line !== 'object' || Array.isArray(line)) throw new Error('对白格式错误');
      for (const field of ['speaker', 'text', 'tone', 'emotion']) {
        if (typeof line[field] !== 'string') throw new Error(`对白 ${field} 必须为字符串`);
      }
      if (line.id !== '' && !(typeof line.id === 'number' && Number.isSafeInteger(line.id) && line.id > 0) &&
        !(typeof line.id === 'string' && /^\d+$/.test(line.id) && Number.isSafeInteger(Number(line.id)) && Number(line.id) > 0)) {
        throw new Error('对白角色 ID 无效');
      }
      return { ...line };
    }).filter((line: any) => line.text.trim() && !isPlaceholderEmptyDialogue(line.text));
  }
  const scene = { ...scenes[sceneIdx] };
  let updated: any;
  if (shotIdx === undefined) {
    if (scene.shots.some((shot: any) => shot.panelStatus === 'generating')) throw new Error('场景中存在生成任务，请稍后修改');
    Object.assign(scene, patch);
    updated = scene;
  } else {
    if (!Number.isSafeInteger(shotIdx) || shotIdx < 0 || !scene.shots[shotIdx]) throw new Error('镜头不存在');
    if (scene.shots[shotIdx].panelStatus === 'generating') throw new Error('镜头正在生成，请稍后修改');
    scene.shots = [...scene.shots];
    updated = { ...scene.shots[shotIdx], ...patch };
    scene.shots[shotIdx] = updated;
  }
  const configs = [...scenes];
  configs[sceneIdx] = scene;
  return { configs, scene, updated };
}
