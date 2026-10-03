import {
  cloneData,
  createDemoModules,
  LEGACY_STORAGE_KEY,
  uid,
  validateCourse,
  WORKSPACE_STORAGE_KEY,
  type BackfillItem,
  type BackfillRequest,
  type CourseModule,
  type CourseVersion,
  type LessonStep,
  type LibraryCourse,
  type PersonalModule,
  type PersonalStep,
  type TeacherCopy,
  toLessonStep,
  stepSignature,
  type Workspace,
  type WorkspaceUser,
} from '../models';
import {
  applyBackfill,
  countCopyConflicts,
  mergeCopyWithVersion,
  publishedVersionOf,
  pullCopy,
  resolveConflictKeepMine,
  resolveConflictTakeUpstream,
  versionAt,
  type SyncReport,
} from './library';

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface PublishOutcome {
  result: ActionResult;
  report?: SyncReport;
  upgradedCopies: string[];
}

const DEFAULT_USERS: WorkspaceUser[] = [
  { id: 'u-leader', name: '林组长（教研组长）', role: 'leader' },
  { id: 'u-chen', name: '陈老师', role: 'teacher' },
  { id: 'u-zhou', name: '周老师', role: 'teacher' },
];

function nowIso(): string {
  return new Date().toISOString();
}

export class PermissionError extends Error {}
export class LibraryOfflineError extends Error {}

export class StudioStore {
  workspace: Workspace;
  private listeners = new Set<() => void>();

  constructor(workspace?: Workspace) {
    this.workspace = workspace ?? this.load();
    // 首次加载 / 迁移完成后立即落盘，保证旧稿拆分结果不丢
    this.persist();
  }

  /* ---------------- 订阅与持久化 ---------------- */

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.persist();
    this.listeners.forEach((listener) => listener());
  }

  private persist(): void {
    try {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(this.workspace));
    } catch {
      // 存储不可用时只保留内存态
    }
  }

  private load(): Workspace {
    try {
      const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Workspace;
        if (parsed.schema === 2) return parsed;
      }
    } catch {
      // 落到迁移
    }
    return this.migrate();
  }

  /* ---------------- v1 迁移：旧稿按归属拆到库和老师名下 ---------------- */

  private migrate(): Workspace {
    let legacyRaw: string | null = null;
    try {
      legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    } catch {
      legacyRaw = null;
    }

    const users = cloneData(DEFAULT_USERS);
    const time = nowIso();

    if (!legacyRaw) {
      const course = this.seedCourse(time);
      const workspace: Workspace = { schema: 2, currentUserId: users[0].id, users, library: [course], copies: [], backfills: [], libraryOnline: true };
      return workspace;
    }

    let legacy: { title?: string; audience?: string; teacher?: string; modules?: CourseModule[]; frozenVersions?: { id: string; label: string; createdAt: string; snapshot: { title?: string; audience?: string; modules: CourseModule[] } }[] } = {};
    try {
      legacy = JSON.parse(legacyRaw);
    } catch {
      legacy = {};
    }

    const modules = (legacy.modules?.length ? legacy.modules : createDemoModules());
    const ownerName = (legacy.teacher || '陈老师').split(/[/／]/)[0].trim() || '陈老师';
    const teacher = users.find((user) => user.role === 'teacher') ?? users[1];
    teacher.name = ownerName.includes('老师') ? ownerName : `${ownerName}老师`;

    // 冻结版本作为课程库历史版本，当前稿进入维护中草稿
    const versions: CourseVersion[] = [];
    (legacy.frozenVersions ?? []).forEach((frozen, index) => {
      versions.push({
        version: index + 1,
        label: frozen.label || `v${index + 1}`,
        publishedAt: frozen.createdAt || time,
        note: '由旧版冻结版本迁移。',
        modules: cloneData(frozen.snapshot.modules ?? modules),
      });
    });
    versions.push({
      version: versions.length + 1,
      label: `v${versions.length + 1}`,
      publishedAt: time,
      note: versions.length ? '由本地当前稿迁移发布。' : '旧本地稿迁移：成为共享课程库的首个发布版本。',
      modules: cloneData(modules),
    });

    const title = legacy.title?.trim() || '零基础手语 · 问候与数量';
    const course: LibraryCourse = {
      id: uid('course'),
      title,
      audience: legacy.audience || '初次接触手语的初中学习者',
      color: '#15827a',
      draftModules: cloneData(modules),
      status: 'published',
      versions,
      publishedVersion: versions.length,
      createdAt: time,
      updatedAt: time,
    };

    // 以前一个人编的稿 → 迁移为该老师名下、来源库的个人副本
    const copy = pullCopy(course, teacher, time);
    copy.lastSyncNotice = '已由旧版本地稿迁移：课程进入共享课程库，你的稿件迁移为个人副本。';

    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // 忽略
    }

    return { schema: 2, currentUserId: teacher.id, users, library: [course], copies: [copy], backfills: [], libraryOnline: true };
  }

  private seedCourse(time: string): LibraryCourse {
    const modules = createDemoModules();
    return {
      id: 'course-greetings',
      title: '零基础手语 · 问候与数量',
      audience: '初次接触手语的初中学习者',
      color: '#15827a',
      draftModules: cloneData(modules),
      status: 'published',
      versions: [{ version: 1, label: 'v1', publishedAt: time, note: '教研组发布的标准课程。', modules: cloneData(modules) }],
      publishedVersion: 1,
      createdAt: time,
      updatedAt: time,
    };
  }

  /* ---------------- 身份与连接 ---------------- */

  get currentUser(): WorkspaceUser {
    return this.workspace.users.find((user) => user.id === this.workspace.currentUserId) ?? this.workspace.users[0];
  }

  get isLeader(): boolean {
    return this.currentUser.role === 'leader';
  }

  switchUser(userId: string): void {
    if (!this.workspace.users.some((user) => user.id === userId)) return;
    this.workspace.currentUserId = userId;
    this.emit();
  }

  setLibraryOnline(online: boolean): void {
    this.workspace.libraryOnline = online;
    if (online) this.drainBackfills();
    this.emit();
  }

  private requireLeader(): void {
    if (this.currentUser.role !== 'leader') {
      throw new PermissionError('只有教研组长可以维护共享课程库，这一步已被拦下。');
    }
  }

  private requireLibraryOnline(action: string): void {
    if (!this.workspace.libraryOnline) {
      throw new LibraryOfflineError(`课程库暂时不可用，${action}没有发出，可以稍后自动重试。`);
    }
  }

  private ownedCopy(copyId: string): TeacherCopy {
    const copy = this.workspace.copies.find((item) => item.id === copyId);
    if (!copy) throw new PermissionError('找不到这份个人课程。');
    if (copy.teacherId !== this.currentUser.id) {
      throw new PermissionError(this.isLeader ? '这是老师名下的课程，组长也不能越权改动。' : '这是其他老师名下的课程，不能越权改动。');
    }
    return copy;
  }

  /* ---------------- 课程库（组长） ---------------- */

  createLibraryCourse(title: string): { result: ActionResult; course?: LibraryCourse } {
    try {
      this.requireLeader();
      this.requireLibraryOnline('新建标准课程');
    } catch (error) {
      return { result: { ok: false, message: (error as Error).message } };
    }
    const time = nowIso();
    const colors = ['#15827a', '#8a3ffc', '#b34331', '#376ea8'];
    const course: LibraryCourse = {
      id: uid('course'),
      title: title.trim() || '未命名标准课程',
      audience: '',
      color: colors[this.workspace.library.length % colors.length],
      draftModules: [],
      status: 'draft',
      versions: [],
      publishedVersion: 0,
      createdAt: time,
      updatedAt: time,
    };
    this.workspace.library.push(course);
    this.emit();
    return { result: { ok: true, message: '已在课程库创建标准课程草稿。' }, course };
  }

  updateLibraryDraft(courseId: string, patch: { title?: string; audience?: string }, modules: CourseModule[]): ActionResult {
    try {
      this.requireLeader();
      this.requireLibraryOnline('课程库修改');
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    const course = this.workspace.library.find((item) => item.id === courseId);
    if (!course) return { ok: false, message: '课程库中没有这门课。' };
    if (patch.title !== undefined) course.title = patch.title;
    if (patch.audience !== undefined) course.audience = patch.audience;
    course.draftModules = cloneData(modules);
    course.updatedAt = nowIso();
    this.emit();
    return { ok: true, message: '标准课程草稿已更新。' };
  }

  /** 发布库的新版本，并立即把所有个人副本里没动过的步骤带着升级 */
  publishLibraryCourse(courseId: string, note: string): PublishOutcome {
    try {
      this.requireLeader();
      this.requireLibraryOnline('发布新版本');
    } catch (error) {
      return { result: { ok: false, message: (error as Error).message }, upgradedCopies: [] };
    }
    const course = this.workspace.library.find((item) => item.id === courseId);
    if (!course) return { result: { ok: false, message: '课程库中没有这门课。' }, upgradedCopies: [] };

    // 先把积压回灌逐项落进草稿，再做发布检查（回灌/手工删改可能留下悬空前置引用，统一清理）
    this.drainBackfillsForCourse(course, false);
    course.draftModules.forEach((module) => {
      const ids = new Set(module.steps.map((step) => step.id));
      module.steps.forEach((step) => {
        if (step.prerequisiteId && !ids.has(step.prerequisiteId)) step.prerequisiteId = '';
      });
    });

    const blocking = validateCourse(course.title, course.draftModules).filter((check) => check.severity === 'error');
    if (blocking.length) {
      return { result: { ok: false, message: `仍有 ${blocking.length} 个阻断问题，修复后才能发布。` }, upgradedCopies: [] };
    }

    const version = course.publishedVersion + 1;
    const label = `v${version}`;
    const time = nowIso();
    const newVersion: CourseVersion = { version, label, publishedAt: time, note: note.trim() || '教研组发布新版本。', modules: cloneData(course.draftModules) };
    course.versions.push(newVersion);
    course.publishedVersion = version;
    course.status = 'published';
    course.updatedAt = time;

    const upgradedCopies: string[] = [];
    this.workspace.copies
      .filter((copy) => copy.libraryCourseId === course.id && copy.sourceVersion < version)
      .forEach((copy) => {
        const base = versionAt(course, copy.sourceVersion) ?? course.versions[0];
        if (!base) return;
        const { modules, report } = mergeCopyWithVersion(copy, base.modules, newVersion.modules, version);
        copy.modules = modules;
        copy.sourceVersion = version;
        copy.lastSavedAt = time;
        copy.lastSyncNotice = this.reportNotice(report);
        upgradedCopies.push(copy.teacherName);
      });

    this.emit();
    return { result: { ok: true, message: `${label} 已发布。` }, upgradedCopies };
  }

  private reportNotice(report: SyncReport): string {
    const parts: string[] = [];
    if (report.upgraded.length) parts.push(`${report.upgraded.length} 个未改动步骤已自动升级`);
    if (report.conflicts.length) parts.push(`${report.conflicts.length} 个步骤需要你对照两版裁定`);
    if (report.added.length) parts.push(`新增 ${report.added.length} 个标准步骤`);
    if (report.removed.length) parts.push(`${report.removed.length} 个库步骤随升级移除`);
    if (report.pendingDeletions.length) parts.push(`${report.pendingDeletions.length} 项库中已删除，等你确认`);
    return parts.length ? parts.join('；') + '。' : '课程库有新版本，内容已同步。';
  }

  /** 老师主动把名下副本升级到库的最新发布版本 */
  upgradeCopy(copyId: string): ActionResult {
    try {
      const copy = this.ownedCopy(copyId);
      this.requireLibraryOnline('版本升级');
      const course = this.workspace.library.find((item) => item.id === copy.libraryCourseId);
      if (!course) return { ok: false, message: '对应的标准课程已不在课程库中。' };
      if (countCopyConflicts(copy) > 0) {
        return { ok: false, message: '还有升级冲突没有裁定，先处理后才能继续升级。' };
      }
      const target = publishedVersionOf(course);
      const base = versionAt(course, copy.sourceVersion);
      if (!target || !base || target.version <= copy.sourceVersion) {
        return { ok: false, message: '已经是课程库的最新版本。' };
      }
      const { modules, report } = mergeCopyWithVersion(copy, base.modules, target.modules, target.version);
      copy.modules = modules;
      copy.sourceVersion = target.version;
      copy.lastSavedAt = nowIso();
      copy.lastSyncNotice = this.reportNotice(report);
      this.emit();
      return { ok: true, message: this.reportNotice(report) };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  /* ---------------- 取课 ---------------- */

  pullFromLibrary(courseId: string): { result: ActionResult; copy?: TeacherCopy } {
    try {
      if (this.isLeader) return { result: { ok: false, message: '教研组长在课程库视图直接维护标准课程。' } };
      this.requireLibraryOnline('取课');
      const course = this.workspace.library.find((item) => item.id === courseId);
      if (!course) return { result: { ok: false, message: '课程库中没有这门课。' } };
      if (!course.versions.length) return { result: { ok: false, message: '这门标准课程还没有发布版本，暂时不能取课。' } };
      const existing = this.workspace.copies.find((copy) => copy.libraryCourseId === courseId && copy.teacherId === this.currentUser.id);
      if (existing) return { result: { ok: false, message: '你名下已经有这门课的副本，请直接在「我的课程」里打开。' } };
      const copy = pullCopy(course, this.currentUser, nowIso());
      this.workspace.copies.push(copy);
      this.emit();
      return { result: { ok: true, message: '已取一份到你名下，可以开始编排学习步骤。' }, copy };
    } catch (error) {
      return { result: { ok: false, message: (error as Error).message } };
    }
  }

  /* ---------------- 个人副本编辑（仅属主老师；组长只读） ---------------- */

  updateCopyMeta(copyId: string, patch: Partial<Pick<TeacherCopy, 'title' | 'audience'>>): ActionResult {
    try {
      const copy = this.ownedCopy(copyId);
      if (this.isLeader) throw new PermissionError('教研组长不能改动老师名下的课程。');
      Object.assign(copy, patch);
      copy.lastSavedAt = nowIso();
      this.emit();
      return { ok: true, message: '已保存。' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  updatePersonalStep(copyId: string, moduleId: string, stepId: string, patch: Partial<PersonalStep>): ActionResult {
    try {
      const copy = this.ownedCopy(copyId);
      if (this.isLeader) throw new PermissionError('教研组长不能改动老师名下的课程。');
      const module = copy.modules.find((item) => item.id === moduleId);
      const step = module?.steps.find((item) => item.id === stepId);
      if (!module || !step) return { ok: false, message: '找不到这个学习步骤。' };
      Object.assign(step, patch);
      // 任何老师编辑都把步骤标记为改过：库里再发布同一步骤时会进入对照
      if (step.state === 'clean') step.state = 'modified';
      if (step.upstreamDeleted) step.upstreamDeleted = false;
      copy.lastSavedAt = nowIso();
      copy.revision += 1;
      this.emit();
      return { ok: true, message: '' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  updatePersonalModule(copyId: string, moduleId: string, patch: Partial<Pick<PersonalModule, 'title' | 'summary' | 'color'>>): ActionResult {
    try {
      const copy = this.ownedCopy(copyId);
      if (this.isLeader) throw new PermissionError('教研组长不能改动老师名下的课程。');
      const module = copy.modules.find((item) => item.id === moduleId);
      if (!module) return { ok: false, message: '找不到这个模块。' };
      Object.assign(module, patch);
      if (module.state === 'clean') module.state = 'modified';
      copy.lastSavedAt = nowIso();
      this.emit();
      return { ok: true, message: '' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  addPersonalModule(copyId: string): { result: ActionResult; module?: PersonalModule } {
    try {
      const copy = this.ownedCopy(copyId);
      if (this.isLeader) throw new PermissionError('教研组长不能改动老师名下的课程。');
      const colors = ['#15827a', '#8a3ffc', '#b34331', '#376ea8'];
      const module: PersonalModule = {
        id: uid('pmodule'),
        sourceModuleId: '',
        title: `新模块 ${copy.modules.length + 1}`,
        summary: '说明该模块的学习目标与适用场景。',
        color: colors[copy.modules.length % colors.length],
        state: 'new',
        steps: [],
      };
      copy.modules.push(module);
      this.emit();
      return { result: { ok: true, message: '已新增模块。' }, module };
    } catch (error) {
      return { result: { ok: false, message: (error as Error).message } };
    }
  }

  addPersonalStep(copyId: string, moduleId: string, kind: LessonStep['kind']): { result: ActionResult; step?: PersonalStep } {
    try {
      const copy = this.ownedCopy(copyId);
      if (this.isLeader) throw new PermissionError('教研组长不能改动老师名下的课程。');
      const module = copy.modules.find((item) => item.id === moduleId);
      if (!module) return { result: { ok: false, message: '找不到模块。' } };
      const prior = module.steps.at(-1);
      const step: PersonalStep = {
        id: uid('pstep'),
        sourceStepId: '',
        state: 'new',
        title: `新${kind}步骤 ${module.steps.length + 1}`,
        kind,
        duration: 45,
        demoTitle: '等待上传或录制示范片段',
        demoUrl: '',
        handshape: '描述起始手形、掌心方向和运动路径。',
        gestureZone: '中央',
        caption: '填写送给学习者的字幕说明。',
        captionPosition: '下方安全区',
        camera: '正面',
        commonMistakes: [],
        exercise: kind === '练习' ? '填写练习任务。' : '',
        exerciseFeedback: kind === '练习' ? '填写反馈方式。' : '',
        altText: '',
        prerequisiteId: prior?.id ?? '',
        difficulty: '入门',
        cuePoints: [8, 20, 32],
      };
      module.steps.push(step);
      copy.revision += 1;
      copy.lastSavedAt = nowIso();
      this.emit();
      return { result: { ok: true, message: '已新增学习步骤。' }, step };
    } catch (error) {
      return { result: { ok: false, message: (error as Error).message } };
    }
  }

  duplicatePersonalStep(copyId: string, moduleId: string, stepId: string): ActionResult {
    try {
      const copy = this.ownedCopy(copyId);
      if (this.isLeader) throw new PermissionError('教研组长不能改动老师名下的课程。');
      const module = copy.modules.find((item) => item.id === moduleId);
      const step = module?.steps.find((item) => item.id === stepId);
      if (!module || !step) return { ok: false, message: '找不到这个步骤。' };
      const duplicate: PersonalStep = {
        ...cloneData(step),
        id: uid('pstep'),
        title: `${step.title}（副本）`,
        sourceStepId: '',
        state: 'new',
        upstreamStep: undefined,
        upstreamDeleted: false,
      };
      const index = module.steps.indexOf(step);
      module.steps.splice(index + 1, 0, duplicate);
      this.emit();
      return { ok: true, message: '已复制步骤。' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  deletePersonalStep(copyId: string, moduleId: string, stepId: string): ActionResult {
    try {
      const copy = this.ownedCopy(copyId);
      if (this.isLeader) throw new PermissionError('教研组长不能改动老师名下的课程。');
      const module = copy.modules.find((item) => item.id === moduleId);
      const step = module?.steps.find((item) => item.id === stepId);
      if (!module || !step) return { ok: false, message: '找不到这个步骤。' };
      if (module.steps.length <= 1) return { ok: false, message: '模块至少保留一个学习步骤。' };
      module.steps = module.steps.filter((item) => item.id !== stepId);
      if (step.sourceStepId) {
        module.droppedStepIds = [...(module.droppedStepIds ?? []), step.sourceStepId];
      }
      // 指向被删步骤的前置依赖清空
      module.steps.forEach((item) => {
        if (item.prerequisiteId === stepId) item.prerequisiteId = '';
      });
      this.emit();
      return { ok: true, message: '已删除学习步骤。' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  movePersonalStep(copyId: string, moduleId: string, stepId: string, direction: number): ActionResult {
    try {
      const copy = this.ownedCopy(copyId);
      if (this.isLeader) throw new PermissionError('教研组长不能改动老师名下的课程。');
      const module = copy.modules.find((item) => item.id === moduleId);
      const index = module?.steps.findIndex((item) => item.id === stepId) ?? -1;
      if (!module || index < 0) return { ok: false, message: '找不到这个步骤。' };
      const next = Math.max(0, Math.min(module.steps.length - 1, index + direction));
      if (next === index) return { ok: true, message: '' };
      const [item] = module.steps.splice(index, 1);
      module.steps.splice(next, 0, item);
      if (item.state === 'clean') item.state = 'modified';
      this.emit();
      return { ok: true, message: '已调整步骤顺序。' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  deletePersonalModule(copyId: string, moduleId: string): ActionResult {
    try {
      const copy = this.ownedCopy(copyId);
      if (this.isLeader) throw new PermissionError('教研组长不能改动老师名下的课程。');
      if (copy.modules.length <= 1) return { ok: false, message: '至少保留一个模块。' };
      copy.modules = copy.modules.filter((item) => item.id !== moduleId);
      this.emit();
      return { ok: true, message: '已删除模块。' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  /* ---------------- 冲突裁定 ---------------- */

  resolveStepConflict(copyId: string, moduleId: string, stepId: string, choice: 'upstream' | 'mine'): ActionResult {
    try {
      const copy = this.ownedCopy(copyId);
      const module = copy.modules.find((item) => item.id === moduleId);
      const step = module?.steps.find((item) => item.id === stepId);
      if (!module || !step) return { ok: false, message: '找不到这个步骤。' };
      const resolved = choice === 'upstream' ? resolveConflictTakeUpstream(step) : resolveConflictKeepMine(step);
      Object.assign(step, resolved);
      this.emit();
      return { ok: true, message: choice === 'upstream' ? '已采用课程库新版本。' : '已保留你的版本。' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  resolveDeletedStep(copyId: string, moduleId: string, stepId: string, keep: boolean): ActionResult {
    try {
      const copy = this.ownedCopy(copyId);
      const module = copy.modules.find((item) => item.id === moduleId);
      const step = module?.steps.find((item) => item.id === stepId);
      if (!module || !step) return { ok: false, message: '找不到这个步骤。' };
      if (keep) {
        step.upstreamDeleted = false;
        step.state = step.state === 'clean' ? 'modified' : step.state;
      } else {
        module.steps = module.steps.filter((item) => item.id !== stepId);
        if (step.sourceStepId) module.droppedStepIds = [...(module.droppedStepIds ?? []), step.sourceStepId];
      }
      this.emit();
      return { ok: true, message: keep ? '该步骤已作为你的个性化内容保留。' : '该步骤已跟随课程库删除。' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  resolveDeletedModule(copyId: string, moduleId: string, keep: boolean): ActionResult {
    try {
      const copy = this.ownedCopy(copyId);
      const module = copy.modules.find((item) => item.id === moduleId);
      if (!module) return { ok: false, message: '找不到这个模块。' };
      if (keep) {
        module.upstreamDeleted = false;
        module.state = 'modified';
        module.sourceModuleId = '';
      } else {
        if (copy.modules.length <= 1) return { ok: false, message: '至少保留一个模块。' };
        copy.modules = copy.modules.filter((item) => item.id !== moduleId);
      }
      this.emit();
      return { ok: true, message: keep ? '该模块已作为你的个性化内容保留。' : '该模块已跟随课程库删除。' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  /* ---------------- 回灌申请 ---------------- */

  submitBackfill(copyId: string, note: string, stepIds?: string[]): ActionResult {
    try {
      const copy = this.ownedCopy(copyId);
      if (this.isLeader) throw new PermissionError('回灌申请由老师发起。');
      const items: BackfillItem[] = [];
      copy.modules.forEach((module) => {
        module.steps.forEach((step, index) => {
          if (step.state === 'clean' || step.state === 'conflict' || step.upstreamDeleted) return;
          if (stepIds && !stepIds.includes(step.id)) return;
          // 已经回灌过且之后没有新改动：不重复进申请
          if (step.backfilledSignature !== undefined && step.backfilledSignature === stepSignature(step)) return;
          // 自建步骤没有库 id：记录它在副本中排在哪个库步骤后面，回灌时按此插入
          let afterStepId = '';
          if (!step.sourceStepId) {
            for (let i = index - 1; i >= 0; i -= 1) {
              const predecessor = module.steps[i];
              if (predecessor.sourceStepId) { afterStepId = predecessor.sourceStepId; break; }
            }
          }
          items.push({
            id: uid('item'),
            copyStepId: step.id,
            copyId: copy.id,
            sourceModuleId: module.sourceModuleId || module.id,
            moduleTitle: module.title,
            sourceStepId: step.sourceStepId,
            step: toLessonStep(step),
            afterStepId,
            signature: stepSignature(step),
            state: 'queued',
          });
        });
      });
      if (!items.length) return { ok: false, message: '没有改过或新增的学习步骤可以回灌。' };

      const request: BackfillRequest = {
        id: uid('backfill'),
        libraryCourseId: copy.libraryCourseId,
        copyId: copy.id,
        courseTitle: copy.title,
        teacherId: copy.teacherId,
        teacherName: copy.teacherName,
        note: note.trim(),
        createdAt: nowIso(),
        status: 'pending',
        items,
      };
      this.workspace.backfills.unshift(request);

      if (this.workspace.libraryOnline) {
        this.applyRequest(request);
      }
      // 课程库不可用：申请原样留住，等恢复后逐项补
      this.emit();
      const failed = request.items.filter((item) => item.state === 'failed').length;
      if (!this.workspace.libraryOnline) {
        return { ok: true, message: `回灌申请已留住（${items.length} 项），课程库恢复后自动逐项补上。` };
      }
      return {
        ok: failed === 0,
        message: failed === 0 ? `已把 ${items.length} 项改动回灌到课程库草稿。` : `${items.length - failed} 项已补上，${failed} 项失败留在申请里待重试。`,
      };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  retryBackfill(requestId: string): ActionResult {
    const request = this.workspace.backfills.find((item) => item.id === requestId);
    if (!request) return { ok: false, message: '找不到这份申请。' };
    if (!this.workspace.libraryOnline) return { ok: false, message: '课程库仍不可用，申请继续保留，恢复后会自动重试。' };
    this.applyRequest(request);
    this.emit();
    const failed = request.items.filter((item) => item.state === 'failed').length;
    return failed === 0
      ? { ok: true, message: `申请剩余 ${request.items.filter((item) => item.state === 'applied').length} 项已全部补上。` }
      : { ok: false, message: `还有 ${failed} 项未能补上，申请已保留。` };
  }

  private applyRequest(request: BackfillRequest): void {
    const course = this.workspace.library.find((item) => item.id === request.libraryCourseId);
    if (!course) {
      request.items.forEach((item) => {
        if (item.state !== 'applied') {
          item.state = 'failed';
          item.message = '标准课程已从库中移除。';
        }
      });
      request.status = 'pending';
      return;
    }
    const { modules, items } = applyBackfill(course.draftModules, request);
    course.draftModules = modules;
    request.items = items;
    course.updatedAt = nowIso();
    this.syncBackfillToCopy(request);
    request.status = items.every((item) => item.state === 'applied') ? 'applied' : 'pending';
  }

  /** 回灌成功后回写老师副本：记住内容指纹、把自建步骤映射成库步骤 */
  private syncBackfillToCopy(request: BackfillRequest): void {
    const copy = this.workspace.copies.find((item) => item.id === request.copyId);
    if (!copy) return;
    request.items.forEach((item) => {
      if (item.state !== 'applied') return;
      copy.modules.forEach((module) => {
        const step = module.steps.find((candidate) => candidate.id === item.copyStepId);
        if (!step) return;
        step.backfilledSignature = item.signature;
        if (!step.sourceStepId && item.assignedLibraryStepId) {
          step.sourceStepId = item.assignedLibraryStepId;
          if (step.state === 'new') step.state = 'modified';
        }
      });
    });
  }

  /** 课程库恢复 / 发布前：把所有挂起申请按学习步骤逐项补上 */
  private drainBackfills(): ActionResult {
    if (!this.workspace.libraryOnline) return { ok: false, message: '' };
    this.workspace.backfills
      .filter((request) => request.status !== 'rejected' && request.items.some((item) => item.state !== 'applied'))
      .forEach((request) => this.applyRequest(request));
    this.emit();
    return { ok: true, message: '' };
  }

  private drainBackfillsForCourse(course: LibraryCourse, emitAfter: boolean): void {
    this.workspace.backfills
      .filter((request) => request.libraryCourseId === course.id && request.status !== 'rejected')
      .forEach((request) => this.applyRequest(request));
    if (emitAfter) this.emit();
  }

  rejectBackfill(requestId: string): ActionResult {
    try {
      this.requireLeader();
      const request = this.workspace.backfills.find((item) => item.id === requestId);
      if (!request) return { ok: false, message: '找不到这份申请。' };
      request.status = 'rejected';
      this.emit();
      return { ok: true, message: '已退回这份回灌申请。' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  /* ---------------- 库草稿编辑（组长，步骤级） ---------------- */

  mutateLibraryStep(courseId: string, moduleId: string, stepId: string | null, patch: Partial<LessonStep> | null, kind?: LessonStep['kind']): ActionResult {
    try {
      this.requireLeader();
      this.requireLibraryOnline('课程库修改');
      const course = this.workspace.library.find((item) => item.id === courseId);
      const module = course?.draftModules.find((item) => item.id === moduleId);
      if (!course || !module) return { ok: false, message: '找不到课程模块。' };
      if (stepId === null) {
        const prior = module.steps.at(-1);
        const stepKind = kind ?? '示范';
        module.steps.push({
          id: uid('libstep'),
          title: `新${stepKind}步骤 ${module.steps.length + 1}`,
          kind: stepKind,
          duration: 45,
          demoTitle: '等待上传或录制示范片段',
          demoUrl: '',
          handshape: '描述起始手形、掌心方向和运动路径。',
          gestureZone: '中央',
          caption: '填写送给学习者的字幕说明。',
          captionPosition: '下方安全区',
          camera: '正面',
          commonMistakes: [],
          exercise: stepKind === '练习' ? '填写练习任务。' : '',
          exerciseFeedback: stepKind === '练习' ? '填写反馈方式。' : '',
          altText: '',
          prerequisiteId: prior?.id ?? '',
          difficulty: '入门',
          cuePoints: [8, 20, 32],
        });
      } else {
        const step = module.steps.find((item) => item.id === stepId);
        if (!step) return { ok: false, message: '找不到这个步骤。' };
        if (patch === null) {
          module.steps = module.steps.filter((item) => item.id !== stepId);
          module.steps.forEach((item) => { if (item.prerequisiteId === stepId) item.prerequisiteId = ''; });
        } else {
          Object.assign(step, patch);
        }
      }
      course.updatedAt = nowIso();
      this.emit();
      return { ok: true, message: '' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  mutateLibraryModule(courseId: string, moduleId: string | null, patch: Partial<CourseModule> | null): ActionResult {
    try {
      this.requireLeader();
      this.requireLibraryOnline('课程库修改');
      const course = this.workspace.library.find((item) => item.id === courseId);
      if (!course) return { ok: false, message: '找不到课程。' };
      if (moduleId === null) {
        const colors = ['#15827a', '#8a3ffc', '#b34331', '#376ea8'];
        course.draftModules.push({
          id: uid('lmodule'),
          title: `新模块 ${course.draftModules.length + 1}`,
          summary: '说明该模块的学习目标与适用场景。',
          color: colors[course.draftModules.length % colors.length],
          steps: [],
        });
      } else {
        const module = course.draftModules.find((item) => item.id === moduleId);
        if (!module) return { ok: false, message: '找不到模块。' };
        if (patch === null) course.draftModules = course.draftModules.filter((item) => item.id !== moduleId);
        else Object.assign(module, patch);
      }
      course.updatedAt = nowIso();
      this.emit();
      return { ok: true, message: '' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  resetWorkspace(): void {
    try {
      localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // 忽略
    }
    this.workspace = this.migrateFresh();
    this.emit();
  }

  private migrateFresh(): Workspace {
    const users = cloneData(DEFAULT_USERS);
    return { schema: 2, currentUserId: users[0].id, users, library: [this.seedCourse(nowIso())], copies: [], backfills: [], libraryOnline: true };
  }
}
