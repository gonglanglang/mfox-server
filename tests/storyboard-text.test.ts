import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStoryboardText } from '../src/tools/storyboard-text'

const SAMPLE = [
  '【场景序号】1',
  '【场景ID】131',
  '【角色ID】32,34',
  '【道具ID】135',
  '【环境】深夜，晴姨家卧室。台灯亮着暖黄的光，墙角堆着扎口的行李袋。',
  '【转场】淡入淡出',
  '【BGM】钢琴独奏,深夜静谧',
  '',
  '【分镜序号】1-1',
  '【景别】中全景',
  '【机位】侧面机位',
  '【运镜】固定镜头',
  '【时长】5',
  '【画面】郭晴与何杰熊并排平躺在床上，两人都望着天花板。',
  '【人物动作】郭晴在画面左、何杰熊在画面右并排平躺，二人面朝上望向天花板。',
  '【台词】何杰熊（内心OS）（低缓/calm）：我很排斥这件事，可只要晴姨开口，我从来没拒绝过。',
  '【音效】虫鸣,窗外风声',
  '',
  '【分镜序号】1-2',
  '【景别】中景',
  '【机位】过肩机位',
  '【运镜】固定镜头',
  '【时长】4',
  '【画面】越过何杰熊的侧脸作前景，焦点落在郭晴脸上。',
  '【人物动作】郭晴居画面左、越何杰熊侧脸可见，视线停在天花板。',
  '【台词】郭晴（低缓/sad）：明天我们就走了。',
  '【台词】旁白（平静/fluent）：后来我才知道，晴姨让我做的，是夫妻之间才会做的事。',
  '【音效】虫鸣',
  '【道具动作】郭晴的手攥住被单。',
  '',
  '【场景序号】2',
  '【场景ID】132',
  '【角色ID】34',
  '【环境】傍晚，奶奶家老屋堂屋。天没黑透，瓦檐外透进一点橘灰天光。',
  '【转场】淡出',
  '',
  '【分镜序号】2-1',
  '【景别】中景',
  '【机位】侧面机位',
  '【运镜】固定镜头',
  '【时长】4',
  '【画面】老式座机的黑壳电话静静摆着。',
  '【人物动作】何杰熊居画面右侧、坐于条凳，视线落在方桌上的座机。',
  '【音效】电话铃声由急转缓',
].join('\n')

test('解析场景与镜头的基本结构', () => {
  const scenes = parseStoryboardText(SAMPLE)
  assert.equal(scenes.length, 2)
  assert.equal(scenes[0].scene_id, '131')
  assert.deepEqual(scenes[0].roles, [{ id: '32' }, { id: '34' }])
  assert.deepEqual(scenes[0].prop_ids, ['135'])
  assert.equal(scenes[0].transition, '淡入淡出')
  assert.equal(scenes[0].bgm, '钢琴独奏,深夜静谧')
  assert.equal(scenes[0].shots.length, 2)
  assert.equal(scenes[0].shots[0].shot_size, '中全景')
  assert.equal(scenes[0].shots[0].camera_angle, '侧面机位')
  assert.equal(scenes[0].shots[0].camera_movement, '固定镜头')
  assert.equal(scenes[0].shots[0].durShort, 5)
  assert.equal(scenes[0].shots[1].durShort, 4)
  assert.match(scenes[0].shots[0].content, /并排平躺在床上/)
  assert.equal(scenes[0].shots[0].sound_effect, '虫鸣,窗外风声')
  assert.equal(scenes[1].scene_id, '132')
  assert.equal(scenes[1].transition, '淡出')
  assert.equal(scenes[1].shots.length, 1)
})

test('角色 id 会下发给同场景的每个镜头', () => {
  const scenes = parseStoryboardText(SAMPLE)
  assert.deepEqual(scenes[0].shots[0].roles, [{ id: '32' }, { id: '34' }])
  assert.deepEqual(scenes[0].shots[1].roles, [{ id: '32' }, { id: '34' }])
  assert.deepEqual(scenes[1].shots[0].roles, [{ id: '34' }])
})

test('台词支持多句，并正确拆出 speaker / tone / emotion', () => {
  const shots = parseStoryboardText(SAMPLE)[0].shots

  // 1-1：带"（内心OS）"的双括号写法，末尾括号才是语气
  const os = shots[0].dialogue
  assert.equal(os.length, 1)
  assert.equal(os[0].speaker, '何杰熊（内心OS）')
  assert.equal(os[0].tone, '低缓')
  assert.equal(os[0].emotion, 'calm')
  assert.match(os[0].text, /我很排斥这件事/)

  // 1-2：两句台词，第二句是旁白
  const two = shots[1].dialogue
  assert.equal(two.length, 2)
  assert.equal(two[0].speaker, '郭晴')
  assert.equal(two[0].tone, '低缓')
  assert.equal(two[0].emotion, 'sad')
  assert.equal(two[0].text, '明天我们就走了。')
  assert.equal(two[1].speaker, '旁白')
  assert.equal(two[1].emotion, 'fluent')
  assert.equal(shots[1].key_prop_action, '郭晴的手攥住被单。')
})

test('省略语气括号时仍能解析', () => {
  const t = [
    '【场景序号】1', '【场景ID】9', '【角色ID】32', '【环境】x',
    '【分镜序号】1-1', '【景别】中景', '【机位】正面机位', '【运镜】固定镜头',
    '【画面】她在说话。', '【台词】郭晴：躺下。',
  ].join('\n')
  const line = parseStoryboardText(t)[0].shots[0].dialogue[0]
  assert.equal(line.speaker, '郭晴')
  assert.equal(line.text, '躺下。')
  assert.equal(line.tone, '')
  assert.equal(line.emotion, 'calm')
})

test('完整镜头缺必需字段时抛错（让上游重出），不静默补默认值', () => {
  const t = [
    '【场景序号】1', '【场景ID】9', '【角色ID】32', '【环境】x',
    '【分镜序号】1-1', '【运镜】固定镜头', '【画面】她在说话。',
  ].join('\n')
  assert.throws(() => parseStoryboardText(t), /缺少【景别】【机位】/)
})

test('被截断时，前面完整的场景照常返回', () => {
  const truncated = [
    '【场景序号】1',
    '【场景ID】131',
    '【角色ID】32,34',
    '【环境】深夜，晴姨家卧室。',
    '【分镜序号】1-1',
    '【景别】中全景',
    '【机位】侧面机位',
    '【运镜】固定镜头',
    '【时长】5',
    '【画面】郭晴与何杰熊并排平躺在床上。',
    '【人物动作】二人面朝上望向天花板。',
    '【台词】郭晴（低缓/sad）：明天我们就走了。',
    '',
    '【场景序号】2',
    '【场景ID】132',
    '【角色ID】34',
    '【环境】傍晚，奶奶家老屋堂屋。',
    '【分镜序号】2-1',
    '【景别】中景',
    '【机位】侧面机位',
    '【运镜】固定', // ← 输出在这里被截断
  ].join('\n')

  const scenes = parseStoryboardText(truncated)
  // 场景 1 完整可用——这正是换掉 JSON 的意义
  assert.equal(scenes.length, 2)
  assert.equal(scenes[0].scene_id, '131')
  assert.equal(scenes[0].shots.length, 1)
  assert.equal(scenes[0].shots[0].dialogue[0].text, '明天我们就走了。')
  // 场景 2 的镜头没写【画面】，视为截断残块被丢弃
  assert.equal(scenes[1].scene_id, '132')
  assert.equal(scenes[1].shots.length, 0)
})

test('中英文逗号与顿号都能分隔 id', () => {
  const t = ['【场景序号】1', '【场景ID】9', '【角色ID】32，34、35', '【环境】x'].join('\n')
  assert.deepEqual(parseStoryboardText(t)[0].roles, [{ id: '32' }, { id: '34' }, { id: '35' }])
  // role_id 取第一个角色
  assert.equal(parseStoryboardText(t)[0].role_id, '32')
})

test('模型照抄 JSON 字面量时不会把 [] 当成 id', () => {
  // 真实踩过的坑：【道具ID】[] 曾让整章因「素材 ID 必须为正整数」失败
  const t = [
    '【场景序号】1', '【场景ID】131', '【角色ID】32,34', '【道具ID】[]', '【环境】x',
    '【分镜序号】1-1', '【景别】中景', '【机位】正面机位', '【运镜】固定镜头', '【画面】她在推纸箱。',
  ].join('\n')
  const scene = parseStoryboardText(t)[0]
  assert.deepEqual(scene.prop_ids, [])
  assert.deepEqual(scene.roles, [{ id: '32' }, { id: '34' }])
})

test('台词按说话人解析角色 ID：不再一律用场景主视角兜底', () => {
  const text = [
    '【场景序号】1', '【场景ID】9', '【角色ID】32,34', '【主视角ID】34', '【环境】x',
    '【分镜序号】1-1', '【景别】中景', '【机位】正面机位', '【运镜】固定镜头', '【画面】她在说话。',
    '【台词】郭晴（平静/calm）：我说了算。',
    '【台词】何杰熊（低声/sad）：好。',
    '【台词】旁白（平静/fluent）：后来我才知道。',
  ].join('\n')
  const characters = [{ id: 32, name: '郭晴' }, { id: 34, name: '何杰熊' }]
  const dialogue = parseStoryboardText(text, characters)[0]!.shots[0]!.dialogue
  // 关键回归：说话人是郭晴就该挂到 32，而不是被主视角 34 覆盖（否则配音会用错音色）
  assert.equal(dialogue[0]!.id, '32')
  assert.equal(dialogue[1]!.id, '34')
  // 旁白不占角色：下游按 narration 处理，id 保留兜底值
  assert.equal(dialogue[2]!.speaker, '旁白')
  assert.equal(dialogue[2]!.id, '34')
})

test('说话人写数字 ID / 名字带括号标注 / 名字不在表中 的处理', () => {
  const mk = (speaker: string) => [
    '【场景序号】1', '【场景ID】1', '【角色ID】32', '【主视角ID】32', '【环境】x',
    '【分镜序号】1-1', '【景别】中景', '【机位】正面机位', '【运镜】固定镜头', '【画面】x。',
    `【台词】${speaker}（平静/calm）：台词。`,
  ].join('\n')
  const characters = [{ id: 32, name: '郭晴（青年）' }]
  // 名字带括号标注 → 宽松匹配（去掉括号后仍是同一人）
  assert.equal(parseStoryboardText(mk('郭晴'), characters)[0]!.shots[0]!.dialogue[0]!.id, '32')
  // 直接写数字 ID
  assert.equal(parseStoryboardText(mk('32'), characters)[0]!.shots[0]!.dialogue[0]!.id, '32')
  // 名字不在角色表 → 回退主视角（并保留原说话人文本，便于人工排查）
  const fallback = parseStoryboardText(mk('张三'), characters)[0]!.shots[0]!.dialogue[0]!
  assert.equal(fallback.id, '32')
  assert.equal(fallback.speaker, '张三')
})

test('道具ID 写「无」或留空都解析为空数组', () => {
  const mk = (v: string) => ['【场景序号】1', '【场景ID】1', '【角色ID】32', `【道具ID】${v}`, '【环境】x'].join('\n')
  assert.deepEqual(parseStoryboardText(mk('无'))[0].prop_ids, [])
  assert.deepEqual(parseStoryboardText(mk(''))[0].prop_ids, [])
})

test('【主视角ID】优先于第一个角色', () => {
  const t = [
    '【场景序号】1', '【场景ID】131', '【主视角ID】34', '【角色ID】32,34', '【环境】x',
  ].join('\n')
  assert.equal(parseStoryboardText(t)[0].role_id, '34')
})

test('空输入或没有标签时返回空数组', () => {
  assert.deepEqual(parseStoryboardText(''), [])
  assert.deepEqual(parseStoryboardText('完全没有标签的普通文字'), [])
})
