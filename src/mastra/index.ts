
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from "@mastra/duckdb";
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability, MastraStorageExporter, MastraPlatformExporter, SensitiveDataFilter } from '@mastra/observability';
import { LongCatGateway } from './gateways/longcat';
import { NovelOutLineWorkFlow, NovelChapterWorkFlow } from './workflows/novel-outline.workflow' // AI自动创建小说生成内容章节 / 已有卷续写下一章

import { characterImageWorkflow } from './workflows/character-image.workflow' // 人物形象图生成
import { characterExtractWorkflow, personaExtractWorkflow, sceneExtractWorkflow, propExtractWorkflow } from './workflows/character-extract.workflow'
// import { storyboardWorkflow } from './workflows/storyboard.workflow' // 分镜脚本生成
import { frameRedrawWorkflow } from './workflows/frame-redraw.workflow' // 分镜重绘
import { frameVideoWorkflow } from './workflows/frame-video.workflow' // 分镜视频生成

import { PolishNovelAgent } from './agents/polish-novel-agent' // 小说润色

// ==================== 二、拆分剧本 ====================
import { NovelScriptAgent } from './agents/NovelScriptAagent/novel-script' // 小说剧本拆分专家
import { ChapterScriptWriterAgent } from './agents/NovelScriptAagent/chapter-script-writer' // 章节剧本化（分镜上游）
import { ScenePlannerAgent } from './agents/NovelScriptAagent/scene-planner' // 场次规划专家
import { ShotBreakerAgent } from './agents/NovelScriptAagent/shot-breaker' // 单场分镜拆解专家
import { ShotContinuityAgent } from './agents/NovelScriptAagent/shot-continuity' // 分镜连续性审查专家
import { FramePromptRendererAgent } from './agents/NovelScriptAagent/frame-prompt-renderer' // 首尾帧提示词渲染
import { ShotPromptInferenceAgent } from './agents/NovelScriptAagent/shot-prompt-inference' // AnimaHub 上下文与尾帧提示词推理
// 剧本拆分工作流注册
import { NovelScriptWorkflow } from './workflows/NovelScriptFlows/novel-script' // 初始化拆分剧本工作流

// ==================== 四、视频生成 ====================
import { VideoPromptGeneratorOmnimodalAgent } from './agents/GenerateVideoFlows/video-prompt-generator-omnimodal' // 视频提示词生成


import { NovelGenAgent } from './agents/novel-gen-agent' // 小说内容生成
import { CharacterImageAgent } from './agents/character-image-agent' // 人物形象图生成
import { CharacterDescriptionAgent } from './agents/character-description-agent'
import { SceneImageAgent } from './agents/scene-image-agent' // 场景设定图生成
import { PropImageAgent } from './agents/prop-image-agent' // 道具设定图生成
import { CharacterExtractAgent } from './agents/character-extract-agent' // 角色信息提取
import { SceneExtractAgent } from './agents/scene-extract-agent' // 场景信息提取
import { PropExtractAgent } from './agents/prop-extract-agent'

export const mastra = new Mastra({
  gateways: { longcat: new LongCatGateway() },
  workflows: {
    NovelOutLineWorkFlow, // AI自动创建小说生成内容章节 / 已有卷续写下一章

    // ==================== 二、拆分剧本 ====================
    NovelScriptWorkflow,

    NovelChapterWorkFlow,
    characterImageWorkflow,
    characterExtractWorkflow,
    personaExtractWorkflow,
    sceneExtractWorkflow,
    propExtractWorkflow,
    frameRedrawWorkflow,
    frameVideoWorkflow
  }, // 注册工作流
  agents: {
    PolishNovelAgent,

    // ==================== 二、拆分剧本 ====================
    ChapterScriptWriterAgent,
    ScenePlannerAgent,
    ShotBreakerAgent,
    ShotContinuityAgent,
    NovelScriptAgent,
    FramePromptRendererAgent,
    ShotPromptInferenceAgent,

    // ==================== 四、视频生成 ====================
    VideoPromptGeneratorOmnimodalAgent,
    
    NovelGenAgent,
    CharacterImageAgent,
    CharacterDescriptionAgent,
    SceneImageAgent,
    PropImageAgent,
    CharacterExtractAgent,
    SceneExtractAgent,
    PropExtractAgent
  }, // 注册agent
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: "mastra-storage",
      url: "file:./mastra.db",
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    }
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    // 用 warn 而非 info：info 级会把每一步的 inputData 原样打印（小说原文动辄数千字），
    // 把终端刷得没法看。业务进度日志走 console.log，不受这里影响。
    level: 'warn',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new MastraStorageExporter(), // Persists observability events to Mastra Storage
          new MastraPlatformExporter(), // Sends observability events to Mastra Platform (if MASTRA_PLATFORM_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});
