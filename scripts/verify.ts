/* 逻辑端到端验证：用真实 Store 跑五条核心流程（localStorage 用内存桩替代） */
const store: any = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
};
(globalThis as any).navigator = { onLine: true };

import { ok as assertOk, throws as assertThrows } from 'node:assert/strict';
import { StudioStore, PermissionError } from '../src/services/studio-store';
import { countCopyConflicts } from '../src/services/library';
import { LEGACY_STORAGE_KEY, WORKSPACE_STORAGE_KEY, type Workspace, type LessonStep, type CourseModule } from '../src/models';

let passed = 0;
function ok(name: string, cond: boolean) { assertOk(cond, name); console.log('  ✓', name); passed += 1; }

/* ---------- 场景 0：v1 旧稿迁移 ---------- */
console.log('场景 0 · v1 旧稿迁移');
{
  const legacy = {
    id: 'p1', title: '旧本地稿课程', teacher: '王老师 / 某学校', audience: '成人入门班',
    status: 'frozen',
    modules: [
      { id: 'm1', title: '旧模块', summary: 's', color: '#15827a', steps: [
        { id: 's1', title: '旧步骤', kind: '示范', duration: 30, demoTitle: 'd', demoUrl: '', handshape: 'h', gestureZone: '中央', caption: 'c', captionPosition: '下方安全区', camera: '正面', commonMistakes: ['x'], exercise: '', exerciseFeedback: '', altText: 'alt', prerequisiteId: '', difficulty: '入门', cuePoints: [1] },
      ] },
    ],
    frozenVersions: [{ id: 'f1', label: '冻结版本 v1', createdAt: new Date().toISOString(), snapshot: { modules: [{ id: 'm1', title: '旧模块', summary: 's', color: '#15827a', steps: [] }] } }],
    lastSavedAt: new Date().toISOString(),
  };
  Object.keys(store).forEach((k) => delete store[k]);
  (globalThis as any).localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacy));
  const s = new StudioStore();
  const ws: Workspace = s.workspace;
  ok('旧稿进了共享课程库', ws.library.length === 1 && ws.library[0].title === '旧本地稿课程');
  ok('冻结版本+当前稿都成为库版本', ws.library[0].versions.length === 2);
  ok('旧稿按归属迁到老师名下', ws.copies.length === 1 && ws.copies[0].teacherName.includes('王老师'));
  ok('迁移后落在老师身份', s.currentUser.role === 'teacher');
  ok('旧 key 已清理', (globalThis as any).localStorage.getItem(LEGACY_STORAGE_KEY) === null);
  ok('新 key 已持久化', Boolean((globalThis as any).localStorage.getItem(WORKSPACE_STORAGE_KEY)));
}

/* ---------- 场景 1：越权拦截 ---------- */
console.log('场景 1 · 权限边界');
{
  Object.keys(store).forEach((k) => delete store[k]);
  const s = new StudioStore();
  const [leader, chen, zhou] = s.workspace.users;
  const course = s.workspace.library[0];
  // 组长不能改老师副本（此时还没有副本，先让陈老师取课）
  s.switchUser(chen.id);
  const pull = s.pullFromLibrary(course.id);
  ok('陈老师取课成功', pull.result.ok);
  const copyId = pull.copy.id;
  // 周老师不能动陈老师的副本
  s.switchUser(zhou.id);
  assertThrows(() => (s as any).ownedCopy(copyId), PermissionError);
  const r = s.updatePersonalStep(copyId, 'module-1', 'step-1-1', { title: '偷改' });
  ok('其他老师越权改动被挡', !r.ok && /越权/.test(r.message));
  ok('内容没有被改', s.workspace.copies.find((c: any) => c.id === copyId).modules[0].steps[0].title !== '偷改');
  // 组长也不能动老师副本
  s.switchUser(leader.id);
  const r2 = s.updatePersonalStep(copyId, 'module-1', 'step-1-1', { title: '组长偷改' });
  ok('组长越权改老师副本也被挡', !r2.ok && /组长/.test(r2.message));
  // 老师不能动课程库
  s.switchUser(chen.id);
  const blocked = s.mutateLibraryStep(course.id, 'module-1', 'step-1-1', { title: '老师改库' });
  ok('老师改库步骤被挡', !blocked.ok && /教研组长/.test(blocked.message));
  const r3 = s.createLibraryCourse('x');
  ok('老师新建标准课程被挡', !r3.result.ok);
}

/* ---------- 场景 2：升级——未改动自动升级，改动过的进冲突 ---------- */
console.log('场景 2 · 发布升级与冲突裁定');
{
  Object.keys(store).forEach((k) => delete store[k]);
  const s = new StudioStore();
  const [leader, chen] = s.workspace.users;
  const course = s.workspace.library[0];
  s.switchUser(chen.id);
  const copyId = s.pullFromLibrary(course.id).copy.id;
  const copy = () => s.workspace.copies.find((c: any) => c.id === copyId);

  // 陈老师只改 step-1-1，其他保持 clean
  const edit = s.updatePersonalStep(copyId, 'module-1', 'step-1-1', { title: '我的你好版本', caption: '老师改过的字幕' });
  ok('老师修改成功并标 modified', edit.ok && copy().modules[0].steps.find((x: any) => x.id === 'step-1-1').state === 'modified');

  // 组长在库里同时改 step-1-1（冲突）和 step-1-2（老师没动→自动升级），并改 step-1-3 的时长后新增一步
  s.switchUser(leader.id);
  const d = course.draftModules;
  const m1 = d.find((m: CourseModule) => m.id === 'module-1')!;
  (m1.steps.find((x: LessonStep) => x.id === 'step-1-1') as LessonStep).caption = '库里的新字幕';
  (m1.steps.find((x: LessonStep) => x.id === 'step-1-2') as LessonStep).duration = 99;
  const pub = s.publishLibraryCourse(course.id, '组长修订');
  ok('v2 发布成功', pub.result.ok && course.publishedVersion === 2);
  ok('陈老师副本被通知升级', pub.upgradedCopies.includes('陈老师'));

  const after = copy();
  const s1 = after.modules[0].steps.find((x: any) => x.id === 'step-1-1');
  const s2 = after.modules[0].steps.find((x: any) => x.id === 'step-1-2');
  ok('没动过的步骤自动升级', s2.duration === 99 && s2.state === 'clean');
  ok('两边都动的步骤进入冲突，老师内容没被替换', s1.state === 'conflict' && s1.caption === '老师改过的字幕');
  ok('库版本被摆出来供对照', s1.upstreamStep && s1.upstreamStep.caption === '库里的新字幕');
  ok('冲突计数正确', countCopyConflicts(after) === 1);
  ok('冲突未裁定前不能再升级', !s.upgradeCopy(copyId).ok);

  // 老师裁定：采用库版本
  s.switchUser(chen.id);
  const resolve = s.resolveStepConflict(copyId, 'module-1', 'step-1-1', 'upstream');
  ok('裁定采用库版本成功', resolve.ok && copy().modules[0].steps.find((x: any) => x.id === 'step-1-1').caption === '库里的新字幕');
  ok('裁定后状态归 clean 且无挂起冲突', countCopyConflicts(copy()) === 0);
  ok('已经是最新版时升级给出提示', !s.upgradeCopy(copyId).ok);
}

/* ---------- 场景 3：保留自己版本 + 库删除处理 ---------- */
console.log('场景 3 · 保留我的版本 / 库删除');
{
  Object.keys(store).forEach((k) => delete store[k]);
  const s = new StudioStore();
  const [leader, chen] = s.workspace.users;
  const course = s.workspace.library[0];
  s.switchUser(chen.id);
  const copyId = s.pullFromLibrary(course.id).copy.id;
  s.updatePersonalStep(copyId, 'module-2', 'step-2-1', { title: '我改的数字课' });
  const copy = () => s.workspace.copies.find((c: any) => c.id === copyId);

  // 组长：删掉 step-2-1（老师改过）、删掉 clean 的 step-2-2（老师没动），再补一步保证模块非空
  s.switchUser(leader.id);
  const m2 = course.draftModules.find((m: CourseModule) => m.id === 'module-2')!;
  m2.steps = m2.steps.filter((x: LessonStep) => x.id !== 'step-2-1' && x.id !== 'step-2-2');
  m2.steps.push({ id: 'step-2-9', title: '新增的价格情景', kind: '示范', duration: 40, demoTitle: 'd', demoUrl: '', handshape: 'h', gestureZone: '中央', caption: 'c', captionPosition: '下方安全区', camera: '正面', commonMistakes: [], exercise: '', exerciseFeedback: '', altText: '价格情景描述', prerequisiteId: '', difficulty: '入门', cuePoints: [5] });
  s.publishLibraryCourse(course.id, '删减数量模块');

  const after = copy();
  const mod2 = after.modules.find((m: any) => m.id === 'module-2')!;
  ok('老师没动的步骤随升级删除', !mod2.steps.some((x: any) => x.id === 'step-2-2'));
  const kept = mod2.steps.find((x: any) => x.id === 'step-2-1');
  ok('老师改过的步骤被保留并标记库已删', kept && kept.upstreamDeleted === true);
  // 老师选择保留为自己的步骤
  s.switchUser(chen.id);
  const keep = s.resolveDeletedStep(copyId, 'module-2', 'step-2-1', true);
  ok('保留为个人步骤成功', keep.ok);
  const retained = copy().modules.find((m: any) => m.id === 'module-2').steps.find((x: any) => x.id === 'step-2-1');
  ok('保留后成为个性化步骤', retained.upstreamDeleted === false && retained.state === 'modified' && retained.title === '我改的数字课');
}

/* ---------- 场景 4：回灌失败留住，恢复后逐项补 ---------- */
console.log('场景 4 · 离线队列与逐项补录');
{
  Object.keys(store).forEach((k) => delete store[k]);
  const s = new StudioStore();
  const [leader, chen] = s.workspace.users;
  const course = s.workspace.library[0];
  s.switchUser(chen.id);
  const copyId = s.pullFromLibrary(course.id).copy.id;
  // 改一个已有步骤 + 自建一个新步骤
  s.updatePersonalStep(copyId, 'module-1', 'step-1-2', { handshape: '老师打磨过的手形说明' });
  s.addPersonalStep(copyId, 'module-1', '练习');
  const newStep = s.workspace.copies.find((c: any) => c.id === copyId).modules[0].steps.at(-1);
  newStep.title = '老师新增的课堂游戏';
  newStep.altText = '游戏动作描述';
  newStep.handshape = '双手击掌';
  // 离线提交
  s.setLibraryOnline(false);
  const sub = s.submitBackfill(copyId, '请组长采纳');
  ok('离线下回灌申请被留住', sub.ok && /留住/.test(sub.message));
  const req = s.workspace.backfills[0];
  ok('两项都处于排队状态', req.items.length === 2 && req.items.every((i: any) => i.state === 'queued'));
  // 离线时取课/发布也被挡
  ok('离线取课被挡', !s.pullFromLibrary(course.id).result.ok);

  // 恢复前，先让组长把目标步骤从库里删掉，制造第一项的结构性失败；新步骤应仍能补入
  s.switchUser(leader.id);
  const m1 = course.draftModules.find((m: CourseModule) => m.id === 'module-1')!;
  m1.steps = m1.steps.filter((x: LessonStep) => x.id !== 'step-1-2');
  // 恢复在线 → 自动逐项补录
  s.setLibraryOnline(true);
  const refreshed = s.workspace.backfills[0];
  const itemUpdate = refreshed.items.find((i: any) => i.sourceStepId === 'step-1-2');
  const itemNew = refreshed.items.find((i: any) => !i.sourceStepId);
  ok('目标已删的更新项独立失败、不拖垮其他项', itemUpdate.state === 'failed' && itemNew.state === 'applied');
  ok('失败申请仍留住', refreshed.status === 'pending');
  ok('新步骤已补进库草稿', course.draftModules.find((m: CourseModule) => m.id === 'module-1')!.steps.some((x: LessonStep) => x.title === '老师新增的课堂游戏'));
  // 失败项无法恢复（目标确实不存在）→ 保留失败信息；验证"恢复后可补"用另一种情况：库临时不可用后恢复
  const retryMissing = s.retryBackfill(refreshed.id);
  ok('结构问题重试后仍保留申请', !retryMissing.ok);

  // 陈老师对另一步做新改动，离线提交：新改动 1 项 + 上轮目标已删的失败项 1 项；已成功回灌的新步骤不再重复
  s.switchUser(chen.id);
  s.updatePersonalStep(copyId, 'module-1', 'step-1-1', { caption: '第二轮打磨字幕' });
  s.setLibraryOnline(false);
  const sub2 = s.submitBackfill(copyId, '第二轮');
  const queuedTwo = s.workspace.backfills.find((r: any) => r.note === '第二轮');
  ok('第二轮申请离线留住，已成功回灌的步骤不重复收集', sub2.ok && queuedTwo.items.length === 2 && queuedTwo.items.every((i: any) => i.state === 'queued'));
  s.setLibraryOnline(true);
  const req2 = s.workspace.backfills.find((r: any) => r.note === '第二轮');
  // 新改动项成功补上，失败项仍留住
  const newItem = req2.items.find((i: any) => i.copyStepId === 'step-1-1');
  const failItem = req2.items.find((i: any) => i.copyStepId === 'step-1-2');
  ok('恢复后可补的逐项补上、永久失败项继续留住', newItem.state === 'applied' && failItem.state === 'failed');
  ok('库草稿拿到老师内容', course.draftModules.find((m: CourseModule) => m.id === 'module-1')!.steps.find((x: LessonStep) => x.id === 'step-1-1')!.caption === '第二轮打磨字幕');

  // 组长发布把老师回灌内容带上线：老师副本不应出现伪冲突（内容已与库一致）
  s.switchUser(leader.id);
  const pub2 = s.publishLibraryCourse(course.id, '收录老师打磨');
  ok('回灌内容随库发布', pub2.result.ok);
  const teacherCopy = s.workspace.copies.find((c: any) => c.id === copyId);
  const realConflicts = teacherCopy.modules.flatMap((m: any) => m.steps).filter((st: any) => st.state === 'conflict');
  ok('已回灌步骤发布后不产生伪冲突（两版内容一致）', realConflicts.length === 0);
  // 仅剩"老师改过、库已删除"的待裁定项，由老师自己决定去留
  s.switchUser(chen.id);
  const pendingDeleted = teacherCopy.modules.flatMap((m: any) => m.steps).filter((st: any) => st.upstreamDeleted);
  ok('库删除但老师改过的步骤仍等老师裁定', pendingDeleted.length === 1 && pendingDeleted[0].id === 'step-1-2');
}

/* ---------- 场景 5：发布带版本说明 + 新增模块随升级下发 ---------- */
console.log('场景 5 · 新增模块/步骤随升级下发');
{
  Object.keys(store).forEach((k) => delete store[k]);
  const s = new StudioStore();
  const [leader, chen] = s.workspace.users;
  const course = s.workspace.library[0];
  s.switchUser(chen.id);
  const copyId = s.pullFromLibrary(course.id).copy.id;
  s.switchUser(leader.id);
  course.draftModules.push({ id: 'module-3', title: '模块三 · 表情配合', summary: '新增', color: '#b34331', steps: [
    { id: 'step-3-1', title: '眉毛与疑问表情', kind: '讲解', duration: 40, demoTitle: 'd', demoUrl: '', handshape: 'h', gestureZone: '中央', caption: 'c', captionPosition: '下方安全区', camera: '正面', commonMistakes: [], exercise: '', exerciseFeedback: '', altText: '面部表情描述', prerequisiteId: '', difficulty: '进阶', cuePoints: [5] },
  ] });
  s.publishLibraryCourse(course.id, '加表情模块');
  const copy = s.workspace.copies.find((c: any) => c.id === copyId);
  ok('新模块自动下发到老师副本', copy.modules.some((m: any) => m.sourceModuleId === 'module-3'));
  ok('下发模块的步骤为 clean', copy.modules.find((m: any) => m.id === 'module-3').steps[0].state === 'clean');
  ok('副本版本号推进', copy.sourceVersion === 2);
}

console.log(`\n全部 ${passed} 项断言通过。`);
