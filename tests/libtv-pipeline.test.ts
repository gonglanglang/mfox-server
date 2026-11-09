import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStoryboardText,
  resolveShotImagePrompt,
  resolveShotMotionPrompt,
  resolveShotPlotDescription,
  resolveShotCharacterRefs,
} from '../src/tools/storyboard-text.js';
import { patchStoryboardScene } from '../src/tools/storyboard-patch.js';
import {
  resolveCapability,
  validateParams,
  collectInputs,
  inferShotVideoMode,
} from '../src/pipeline/model-schema.js';
import {
  recordShotAssetVersion,
  listShotAssetVersions,
  selectShotAssetVersion,
  applyAssetVersionToConfigs,
  clearMemoryShotAssets,
} from '../src/pipeline/shot-assets-store.js';
import { runNode, runSubgraph } from '../src/pipeline/scheduler.js';
import { buildTimelineClipFilters } from '../src/tools/video-compose.js';
import { buildUpscaleFilter } from '../src/videoTools/upscale.js';

test('P0: storyboard-text parses all 11 LibTV fields and dual prompts', () => {
  const raw = [
    '【场景序号】1',
    '【场景ID】134',
    '【环境】雨夜青石巷，两侧灯笼摇曳',
    '【转场】叠化',
    '【BGM】低沉古筝',
    '【分镜序号】1-1',
    '【时长】6',
    '【景别】中景',
    '【机位】平视',
    '【运镜】慢推',
    '【情节】沈墨撑伞停在巷口回望',
    '【画面提示词】雨夜青石巷口，沈墨右手撑油纸伞定格，侧脸冷峻，暖黄灯笼光勾勒轮廓',
    '【运动提示词】in: 沈墨撑伞静止 -> path: 镜头缓慢推进，沈墨微微偏头看向巷尾 -> out: 眼神锁定暗处',
    '【场景标签】雨夜、古巷、悬疑',
    '【灯光】冷暖对比侧逆光',
    '【情绪】压抑紧绷',
    '【角色动作】右手稳稳握住竹伞柄，左肩微侧',
    '【角色参考】沈墨|https://cdn.example.com/shenmo.png|黑衣佩剑青年；林晚|https://cdn.example.com/linwan.png|白衣医女',
    '【生成模式】singleImage2video',
    '【参考帧】https://cdn.example.com/ref-1-1.png',
    '【模型参数】{"camera_fixed":false,"seed":42}',
    '【音效】雨滴敲击油纸伞声',
    '【台词】沈墨（低沉/calm）：有人跟了一路。',
  ].join('\n');

  const scenes = parseStoryboardText(raw);
  assert.equal(scenes.length, 1);
  const shot = scenes[0].shots[0];

  assert.equal(shot.plot_description, '沈墨撑伞停在巷口回望');
  assert.equal(
    shot.image_prompt,
    '雨夜青石巷口，沈墨右手撑油纸伞定格，侧脸冷峻，暖黄灯笼光勾勒轮廓',
  );
  assert.equal(
    shot.motion_prompt,
    'in: 沈墨撑伞静止 -> path: 镜头缓慢推进，沈墨微微偏头看向巷尾 -> out: 眼神锁定暗处',
  );
  assert.equal(shot.scene_tags, '雨夜、古巷、悬疑');
  assert.equal(shot.lighting, '冷暖对比侧逆光');
  assert.equal(shot.emotion, '压抑紧绷');
  assert.equal(shot.character_action, '右手稳稳握住竹伞柄，左肩微侧');
  assert.equal(shot.gen_mode, 'singleImage2video');
  assert.equal(shot.reference_frame_url, 'https://cdn.example.com/ref-1-1.png');
  assert.deepEqual(shot.model_params, { camera_fixed: false, seed: 42 });
  assert.equal(shot.character_refs?.length, 2);
  assert.equal(shot.character_refs?.[0].name, '沈墨');
  assert.equal(shot.character_refs?.[0].image_url, 'https://cdn.example.com/shenmo.png');
  assert.equal(shot.character_refs?.[0].description, '黑衣佩剑青年');
});

test('P0: legacy chapter fallback and row-level character reference resolution', () => {
  const legacyShot = {
    content: '旧版画面描述：客栈大厅剑拔弩张',
    subject_motion: '旧版主体运动：缓慢拔剑',
    roles: [{ id: 101 }],
  };
  assert.equal(resolveShotImagePrompt(legacyShot), '旧版画面描述：客栈大厅剑拔弩张');
  assert.equal(resolveShotMotionPrompt(legacyShot), '旧版主体运动：缓慢拔剑');
  assert.equal(resolveShotPlotDescription(legacyShot), '旧版画面描述：客栈大厅剑拔弩张');

  const refs = resolveShotCharacterRefs(legacyShot, [
    {
      id: 101,
      name: '叶孤城',
      image_url: 'https://cdn.example.com/ye.png',
      description: '白衣剑客',
    },
  ]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, '叶孤城');
  assert.equal(refs[0].image_url, 'https://cdn.example.com/ye.png');

  // Patching new fields on a shot
  const scenes: any[] = [
    {
      environment: '客栈',
      shots: [
        {
          ...legacyShot,
          shot_size: '中景',
          camera_angle: '平视',
          camera_movement: '固定',
          dialogue: [],
          sound_effect: '',
        },
      ],
    },
  ];
  const patched = patchStoryboardScene(scenes, 0, 0, {
    image_prompt: '新版静态首帧构图',
    motion_prompt: '新版动态运镜描述',
    gen_mode: 'frames2video',
    lighting: '烛火暖光',
    emotion: '肃杀',
  });
  assert.equal(patched.updated.image_prompt, '新版静态首帧构图');
  assert.equal(patched.updated.motion_prompt, '新版动态运镜描述');
  assert.equal(patched.updated.gen_mode, 'frames2video');
  assert.equal(patched.updated.lighting, '烛火暖光');
});

test('P1: shot_assets multi-version storage and isolated single-shot node rerun', async () => {
  clearMemoryShotAssets();
  const configs: any[] = [
    {
      environment: '竹林',
      shots: [
        { content: '镜头1', firstFrameUrl: 'https://cdn.example.com/s1-v1.png', finalVideoUrl: 'https://cdn.example.com/s1.mp4' },
        { content: '镜头2', firstFrameUrl: 'https://cdn.example.com/s2-v1.png', finalVideoUrl: 'https://cdn.example.com/s2.mp4' },
        { content: '镜头3', firstFrameUrl: 'https://cdn.example.com/s3-v1.png', finalVideoUrl: 'https://cdn.example.com/s3.mp4' },
      ],
    },
  ];

  // Record v1 and v2 for Shot #2 (shotIndex = 1)
  const v1 = await recordShotAssetVersion({
    workId: 1,
    chapterId: 10,
    sceneIndex: 0,
    shotIndex: 1,
    assetType: 'first_frame',
    url: 'https://cdn.example.com/s2-v1.png',
    prompt: 'v1 prompt',
    modelKey: 'seedream-5.0',
  });
  const v2 = await recordShotAssetVersion({
    workId: 1,
    chapterId: 10,
    sceneIndex: 0,
    shotIndex: 1,
    assetType: 'first_frame',
    url: 'https://cdn.example.com/s2-v2.png',
    prompt: 'v2 prompt',
    modelKey: 'seedream-5.0',
  });

  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  assert.equal(v2.is_current, 1);

  const list = await listShotAssetVersions({
    chapterId: 10,
    sceneIndex: 0,
    shotIndex: 1,
    assetType: 'first_frame',
  });
  assert.equal(list.length, 2);
  assert.equal(list[0].version, 2);
  assert.equal(list[0].is_current, 1);
  assert.equal(list[1].version, 1);
  assert.equal(list[1].is_current, 0);

  // Switch back to v1 and verify Shot #2 updates and marks videoNeedsRerun without touching Shot #1 or Shot #3
  const switched = await selectShotAssetVersion({
    chapterId: 10,
    sceneIndex: 0,
    shotIndex: 1,
    assetType: 'first_frame',
    version: 1,
  });
  assert.equal(switched.selected.version, 1);
  assert.equal(switched.videoNeedsRerun, true);

  const applied = applyAssetVersionToConfigs(configs, 0, 1, switched.selected);
  assert.equal(applied.configs[0].shots[1].firstFrameUrl, 'https://cdn.example.com/s2-v1.png');
  assert.equal(applied.configs[0].shots[1].videoNeedsRerun, true);
  assert.equal(applied.configs[0].shots[0].firstFrameUrl, 'https://cdn.example.com/s1-v1.png');
  assert.equal(applied.configs[0].shots[2].firstFrameUrl, 'https://cdn.example.com/s3-v1.png');

  // Verify scheduler isolated single-shot rerun (rerunning Shot #2 does not touch Shot #1 or Shot #3)
  const executedShots: number[] = [];
  const singleRes = await runNode({
    chapterId: 10,
    sceneIndex: 0,
    shotIndex: 1,
    nodeType: 'image',
    configs: applied.configs,
    generator: async () => {
      executedShots.push(1);
      return { url: 'https://cdn.example.com/s2-v3.png' };
    },
  });
  assert.deepEqual(executedShots, [1]);
  assert.equal(singleRes.configs?.[0].shots[1].firstFrameUrl, 'https://cdn.example.com/s2-v3.png');
  assert.equal(singleRes.configs?.[0].shots[0].firstFrameUrl, 'https://cdn.example.com/s1-v1.png');
  assert.equal(singleRes.configs?.[0].shots[2].firstFrameUrl, 'https://cdn.example.com/s3-v1.png');

  // Verify batch subgraph execution
  const batchRes = await runSubgraph({
    chapterId: 10,
    nodeType: 'image',
    targets: [
      { sceneIndex: 0, shotIndex: 0 },
      { sceneIndex: 0, shotIndex: 2 },
    ],
    concurrency: 2,
    configs: singleRes.configs,
    generator: async (req: any) => ({
      url: `https://cdn.example.com/batch-${req.prompt || 'img'}.png`,
    }),
  });
  assert.equal(batchRes.total, 2);
  assert.equal(batchRes.succeeded, 2);
});

test('P2: model-schema capability resolution, param validation, and modeType input collection', () => {
  const cap = resolveCapability({
    key: 'doubao-seedance-2-0-pro',
    capabilities: {
      modes: ['text2video', 'singleImage2video', 'frames2video', 'image2video', 'video2video', 'audio2video', 'mixed2video'],
      params: {
        aspectRatio: ['16:9', '9:16'],
        duration: [5, 10],
        resolution: ['720p', '1080p'],
      },
      inputLimits: {
        maxImages: 3,
        maxVideos: 1,
        maxAudios: 1,
      },
    },
  });

  // Valid params pass
  const validCheck = validateParams(cap, {
    mode: 'singleImage2video',
    aspectRatio: '16:9',
    duration: 5,
    resolution: '1080p',
  });
  assert.equal(validCheck.valid, true);
  assert.equal(validCheck.errors.length, 0);

  // Unsupported mode returns readable error in validateParams and throws in collectInputs
  const invalidCheck = validateParams(cap, { mode: 'videoEdit2video' });
  assert.equal(invalidCheck.valid, false);
  assert.ok(invalidCheck.errors.some(e => e.includes('videoEdit2video')));

  assert.throws(
    () => collectInputs({ content: '测试' }, 'videoEdit2video', cap),
    /不支持生成模式 "videoEdit2video"/,
  );

  // Collect inputs for singleImage2video
  const i2vInputs = collectInputs(
    { firstFrameUrl: 'https://cdn.example.com/first.png', lastFrameUrl: 'https://cdn.example.com/last.png' },
    'singleImage2video',
    cap,
  );
  assert.equal(i2vInputs.media.length, 1);
  assert.equal(i2vInputs.media[0].role, 'first_frame');

  // Collect inputs for frames2video
  const f2vInputs = collectInputs(
    { firstFrameUrl: 'https://cdn.example.com/first.png', lastFrameUrl: 'https://cdn.example.com/last.png' },
    'frames2video',
    cap,
  );
  assert.equal(f2vInputs.media.length, 2);
  assert.equal(f2vInputs.media[1].role, 'last_frame');

  // Missing lastFrameUrl in frames2video throws readable error
  assert.throws(
    () => collectInputs({ firstFrameUrl: 'https://cdn.example.com/first.png' }, 'frames2video', cap),
    /必须同时提供首帧图（firstFrameUrl）与尾帧图（lastFrameUrl）/,
  );

  // Exceeding inputLimits throws readable error
  assert.throws(
    () =>
      collectInputs(
        {
          firstFrameUrl: 'https://cdn.example.com/1.png',
          character_refs: [
            { name: 'A', image_url: 'https://cdn.example.com/2.png' },
            { name: 'B', image_url: 'https://cdn.example.com/3.png' },
            { name: 'C', image_url: 'https://cdn.example.com/4.png' },
          ],
        },
        'image2video',
        cap,
      ),
    /超出模型上限 3 张/,
  );

  assert.equal(inferShotVideoMode({ gen_mode: 'audio2video' }), 'audio2video');
});

test('P3: timeline clip filters, dual-track volume, and video upscale filter', () => {
  const filters = buildTimelineClipFilters(
    {
      url: 'https://cdn.example.com/clip1.mp4',
      duration: 4,
      sourceOffset: 1.5,
      sourceDuration: 4,
      decibel: -6,
    },
    10,
    {
      videoAudioMuted: false,
      videoAudioVolume: 0.8,
    },
  );

  assert.equal(filters.effectiveDuration, 4);
  assert.ok(filters.videoTrimFilters.some(f => f.includes('trim=start=1.500:duration=4.000')));
  assert.ok(filters.audioTrimAndVolumeFilters.includes('volume=-6dB'));
  assert.ok(filters.audioTrimAndVolumeFilters.includes('volume=0.80'));

  const mutedFilters = buildTimelineClipFilters(
    {
      url: 'https://cdn.example.com/clip1.mp4',
      duration: 4,
    },
    10,
    {
      videoAudioMuted: true,
    },
  );
  assert.ok(mutedFilters.audioTrimAndVolumeFilters.includes('volume=0'));

  const upscale2k = buildUpscaleFilter('2k', '16:9');
  assert.equal(upscale2k.width, 2560);
  assert.equal(upscale2k.height, 1440);
  assert.ok(upscale2k.filter.includes('flags=lanczos'));
  assert.ok(upscale2k.filter.includes('unsharp='));
});
