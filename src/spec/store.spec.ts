import { WorkspaceStore } from '../store';
import {
  createDemoLegacyProject,
  LEADER_ID,
  TEACHER_LIN_ID,
  TEACHER_WANG_ID,
  type Workspace,
} from '../models';

function freshStore(): WorkspaceStore {
  localStorage.clear();
  const store = new WorkspaceStore();
  return store;
}

function as(store: WorkspaceStore, id: string): void {
  store.switchIdentity(id);
}

describe('旧数据按归属迁移', () => {
  it('把 v1 单人稿迁到对应老师名下，与库一致步骤挂接为 clean，其余为 local', () => {
    localStorage.clear();
    localStorage.setItem('sologsb-1012-sign-course-project-v1', JSON.stringify(createDemoLegacyProject()));
    const store = new WorkspaceStore();
    const workspace = store.workspace as Workspace;

    expect(workspace.migration).toBeTruthy();
    expect(workspace.migration!.ownerName).toBe('林老师');
    const mine = workspace.personalCourses[0];
    expect(mine.ownerId).toBe(TEACHER_LIN_ID);
    expect(mine.modules.reduce((n, m) => n + m.steps.length, 0)).toBe(5);

    const states = mine.modules.flatMap((m) => m.steps.map((s) => s.state));
    expect(states.filter((s) => s === 'clean').length).toBe(4);
    expect(states.filter((s) => s === 'local').length).toBe(1);

    // 前置依赖在 id 换成库 id 后仍然成立（第 2、3 步均挂接到课程库）
    const firstModule = mine.modules[0];
    expect(firstModule.steps[2].prerequisiteId).toBe(firstModule.steps[1].id);
    expect(firstModule.steps[1].id).toBe('lib-step-hello-breakdown');
  });
});

describe('共享课程库权限', () => {
  it('老师不能改课程库，操作被挡下', () => {
    const store = freshStore();
    as(store, TEACHER_LIN_ID);
    const course = store.libraryCourses[0];
    const module = course.modules[0];
    const step = module.steps[0];
    const before = step.title;
    const result = store.updateLibraryStep(course.id, module.id, step.id, { title: '老师偷改' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('越权');
    expect(store.findLibraryStep(course.id, step.id)!.step.title).toBe(before);
  });

  it('教研组长可以改库步骤并发布新版本', () => {
    const store = freshStore();
    as(store, LEADER_ID);
    const course = store.libraryCourses[0];
    const module = course.modules[0];
    const step = module.steps[0];
    expect(store.updateLibraryStep(course.id, module.id, step.id, { title: '标准你好 v2' }).ok).toBe(true);
    const publish = store.publishLibraryCourse(course.id, '更新问候步骤');
    expect(publish.ok).toBe(true);
    expect(store.getLibraryCourse(course.id)!.currentVersion).toBe(2);
    expect(store.findLibraryStep(course.id, step.id)!.step.version).toBe(2);
  });

  it('课程库中断时组长发布被挡下', () => {
    const store = freshStore();
    as(store, LEADER_ID);
    store.setLibraryOnline(false);
    const course = store.libraryCourses[0];
    const result = store.publishLibraryCourse(course.id, '断网发布');
    expect(result.ok).toBe(false);
    expect(store.getLibraryCourse(course.id)!.currentVersion).toBe(1);
  });
});

describe('取用与版本升级', () => {
  it('老师取用课程得到个人副本，同一门课不能重复取用', () => {
    const store = freshStore();
    as(store, TEACHER_WANG_ID);
    const course = store.libraryCourses[0];
    expect(store.checkoutFromLibrary(course.id).ok).toBe(true);
    const again = store.checkoutFromLibrary(course.id);
    expect(again.ok).toBe(false);
    const mine = store.personalCourses[0];
    expect(mine.libraryCourseId).toBe(course.id);
    expect(mine.basedOnVersion).toBe(1);
    expect(mine.modules[0].steps.every((s) => s.state === 'clean')).toBe(true);
  });

  it('发布新版本：未改动步骤自动升级，改动过的步骤保留并产生两版冲突', () => {
    const store = freshStore();
    as(store, TEACHER_WANG_ID);
    const library = store.libraryCourses[0];
    store.checkoutFromLibrary(library.id);
    const mine = store.personalCourses[0];
    const targetModule = mine.modules[0];
    const untouched = targetModule.steps[1];
    const modified = targetModule.steps[0];
    // 老师先在自己名下改第一步
    store.updatePersonalStep(mine.id, targetModule.id, modified.id, { caption: modified.caption + '（王老师课堂补充）' });
    const teacherCaption = modified.caption;

    as(store, LEADER_ID);
    store.updateLibraryStep(library.id, library.modules[0].id, untouched.id, { title: '库里更新的第二步' });
    store.updateLibraryStep(library.id, library.modules[0].id, modified.id, { caption: '库里更新的第一步字幕' });
    expect(store.publishLibraryCourse(library.id, 'v2').ok).toBe(true);

    // 切回老师检查副本
    as(store, TEACHER_WANG_ID);
    const updated = store.getPersonalCourse(mine.id)!;
    const stepUntouched = updated.modules[0].steps.find((s) => s.id === untouched.id)!;
    const stepModified = updated.modules[0].steps.find((s) => s.id === modified.id)!;
    expect(stepUntouched.title).toBe('库里更新的第二步');
    expect(stepUntouched.state).toBe('clean');
    // 老师的自改内容不能被悄悄替换
    expect(stepModified.caption).toBe(teacherCaption);
    expect(stepModified.state).not.toBe('clean');
    const conflict = updated.conflicts.find((c) => c.stepId === modified.id && !c.choice)!;
    expect(conflict).toBeTruthy();
    expect(conflict.libraryStep.caption).toBe('库里更新的第一步字幕');
    expect(conflict.mineStep.caption).toBe(teacherCaption);
    expect(updated.basedOnVersion).toBe(2);
  });

  it('老师在冲突中可以选用库版本或保留自己的版本', () => {
    const store = freshStore();
    as(store, TEACHER_WANG_ID);
    const library = store.libraryCourses[0];
    store.checkoutFromLibrary(library.id);
    const mine = store.personalCourses[0];
    const target = mine.modules[0].steps[0];
    as(store, TEACHER_WANG_ID);
    store.updatePersonalStep(mine.id, mine.modules[0].id, target.id, { caption: '我的字幕' });

    as(store, LEADER_ID);
    store.updateLibraryStep(library.id, library.modules[0].id, target.id, { caption: '库字幕' });
    store.publishLibraryCourse(library.id, 'v2');

    as(store, TEACHER_WANG_ID);
    const course = store.getPersonalCourse(mine.id)!;
    const conflict = course.conflicts[0];
    store.resolveConflict(course.id, conflict.moduleId, conflict.stepId, 'library');
    const adopted = store.getPersonalCourse(mine.id)!.modules[0].steps.find((s) => s.id === target.id)!;
    expect(adopted.caption).toBe('库字幕');
    expect(adopted.state).toBe('resolved');
    expect(store.getPersonalCourse(mine.id)!.conflicts[0].choice).toBe('library');
  });

  it('冲突未决时直接编辑步骤，按"保留我的版本"结案且不回盖刚输入的内容', () => {
    const store = freshStore();
    as(store, TEACHER_WANG_ID);
    const library = store.libraryCourses[0];
    store.checkoutFromLibrary(library.id);
    const mine = store.personalCourses[0];
    const module0 = mine.modules[0];
    const target = module0.steps[0];
    store.updatePersonalStep(mine.id, module0.id, target.id, { caption: '第一版自改' });

    as(store, LEADER_ID);
    store.updateLibraryStep(library.id, library.modules[0].id, target.id, { caption: '库新版字幕' });
    store.publishLibraryCourse(library.id, 'v2');

    as(store, TEACHER_WANG_ID);
    const conflicted = store.getPersonalCourse(mine.id)!;
    expect(conflicted.conflicts[0].choice).toBeFalsy();
    // 冲突摆着时老师继续输入：新内容必须保留，不能被冲突快照覆盖
    store.updatePersonalStep(mine.id, module0.id, target.id, { caption: '第二版自改（直接输入）' });
    const after = store.getPersonalCourse(mine.id)!;
    const step = after.modules[0].steps.find((s) => s.id === target.id)!;
    expect(step.caption).toBe('第二版自改（直接输入）');
    expect(after.conflicts[0].choice).toBe('mine');
    expect(after.conflicts[0].mineStep.caption).toBe('第二版自改（直接输入）');
  });
});

describe('回灌中断与重试', () => {
  it('回灌被采纳并发布后，老师副本静默对齐，不再产生冲突', () => {
    const store = freshStore();
    as(store, TEACHER_WANG_ID);
    const library = store.libraryCourses[0];
    store.checkoutFromLibrary(library.id);
    const mine = store.personalCourses[0];
    const targetModule = mine.modules[0];
    const target = targetModule.steps[0];
    store.updatePersonalStep(mine.id, targetModule.id, target.id, { handshape: '教研统一采纳的新手形' });

    // 回灌
    const request = store.requestBackfill(mine.id, '建议采纳', [target.id]);
    expect(request.ok).toBe(true);
    expect(store.requests[0].items[0].status).toBe('applied');

    // 组长发布
    as(store, LEADER_ID);
    expect(store.publishLibraryCourse(library.id, '采纳回灌').ok).toBe(true);

    as(store, TEACHER_WANG_ID);
    const updated = store.getPersonalCourse(mine.id)!;
    const same = updated.modules[0].steps.find((s) => s.id === target.id)!;
    expect(same.state).toBe('clean');
    expect(same.handshape).toBe('教研统一采纳的新手形');
    expect(updated.conflicts.filter((c) => !c.choice).length).toBe(0);
  });
});

describe('回灌中断与重试', () => {
  it('课程库中断时申请先留住，恢复后按学习步骤逐项补上', () => {
    const store = freshStore();
    as(store, TEACHER_WANG_ID);
    const library = store.libraryCourses[0];
    store.checkoutFromLibrary(library.id);
    const mine = store.personalCourses[0];
    const module = mine.modules[0];
    const [a, b] = module.steps;
    store.updatePersonalStep(mine.id, module.id, a.id, { caption: '改动 A' });
    store.updatePersonalStep(mine.id, module.id, b.id, { caption: '改动 B' });

    // 断库后申请
    store.setLibraryOnline(false);
    const result = store.requestBackfill(mine.id, '断网也要先留住', [a.id, b.id]);
    expect(result.ok).toBe(true);
    const request = store.requests[0];
    expect(request.items.every((item) => item.status === 'pending' || item.status === 'failed')).toBe(true);
    // 库里内容此时未变
    expect(store.findLibraryStep(library.id, a.id)!.step.caption).not.toBe('改动 A');

    // 恢复重试
    store.setLibraryOnline(true);
    const retry = store.retryPendingBackfills();
    expect(retry.ok).toBe(true);
    expect(store.findLibraryStep(library.id, a.id)!.step.caption).toBe('改动 A');
    expect(store.findLibraryStep(library.id, b.id)!.step.caption).toBe('改动 B');
    expect(request.items.every((item) => item.status === 'applied')).toBe(true);
  });

  it('单项回灌失败不影响其他步骤，失败项保留可重试', () => {
    const store = freshStore();
    as(store, TEACHER_WANG_ID);
    const library = store.libraryCourses[0];
    store.checkoutFromLibrary(library.id);
    const mine = store.personalCourses[0];
    const module = mine.modules[0];
    const a = module.steps[0];
    store.updatePersonalStep(mine.id, module.id, a.id, { caption: '改动 A' });

    const result = store.requestBackfill(mine.id, '', [a.id]);
    expect(result.ok).toBe(true);
    const item = store.requests[0].items[0];
    // 模拟库中该步骤被删除后重试：单项失败保留
    const located = store.findLibraryStep(library.id, a.id)!;
    located.module.steps = located.module.steps.filter((s) => s.id !== a.id);
    item.status = 'pending';
    const retry = store.retryPendingBackfills();
    expect(retry.ok).toBe(false);
    expect(item.status).toBe('failed');
    expect(item.error).toContain('找不到');
    // 申请记录仍然保留
    expect(store.requests[0].items.length).toBe(1);
  });

  it('组长退回某个回灌步骤时，库工作稿该步还原为补入前内容，其他步骤保留', () => {
    const store = freshStore();
    as(store, TEACHER_WANG_ID);
    const library = store.libraryCourses[0];
    store.checkoutFromLibrary(library.id);
    const mine = store.personalCourses[0];
    const module = mine.modules[0];
    const [a, b] = module.steps;
    const originalCaptionA = store.findLibraryStep(library.id, a.id)!.step.caption;
    store.updatePersonalStep(mine.id, module.id, a.id, { caption: '老师改 A' });
    store.updatePersonalStep(mine.id, module.id, b.id, { caption: '老师改 B' });
    store.requestBackfill(mine.id, '', [a.id, b.id]);

    as(store, LEADER_ID);
    const request = store.requests[0];
    const itemA = request.items.find((i) => i.stepId === a.id)!;
    const result = store.reviewBackfillItem(request.id, itemA.id, false);
    expect(result.ok).toBe(true);
    // A 被还原，B 保留补入
    expect(store.findLibraryStep(library.id, a.id)!.step.caption).toBe(originalCaptionA);
    expect(store.findLibraryStep(library.id, b.id)!.step.caption).toBe('老师改 B');
    expect(itemA.status).toBe('rejected');
  });
});
