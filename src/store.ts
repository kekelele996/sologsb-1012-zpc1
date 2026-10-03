import {
  clone,
  createDemoLegacyProject,
  createSeedWorkspace,
  fingerprint,
  isLegacyProject,
  LEGACY_STORAGE_KEY,
  migrateLegacyProject,
  STORAGE_KEY,
  TEACHER_LIN_ID,
  uid,
  validateCourse,
  type BackfillItem,
  type BackfillRequest,
  type ConflictChoice,
  type CourseModule,
  type Identity,
  type LessonStep,
  type LibraryCourse,
  type LibraryModule,
  type LibraryStep,
  type PersonalCourse,
  type PersonalModule,
  type PersonalStep,
  type StepConflict,
  type ValidationCheck,
  type Workspace,
} from './models';

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * 纯内存 + localStorage 的"课程库服务"。
 * libraryOnline = false 用来模拟课程库中断：所有写库动作被挡下，
 * 但老师的编辑与回灌申请照常留在本地。
 */
export class WorkspaceStore {
  workspace: Workspace;

  constructor() {
    this.workspace = this.load();
  }

  // ── 持久化与初始化 ─────────────────────────────────────────

  private load(): Workspace {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Workspace;
        if (parsed.version === 2) return parsed;
      }
    } catch {
      /* 落到种子数据 */
    }

    // 首次进入：先生成课程库，再把 v1 旧单人稿按归属迁过来。
    // 为演示迁移，首次进入时若无任何旧稿，补一份重构前的典型本地稿。
    if (!localStorage.getItem(LEGACY_STORAGE_KEY)) {
      localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(createDemoLegacyProject()));
    }
    const seeded = createSeedWorkspace();
    try {
      const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacyRaw) {
        const legacy = JSON.parse(legacyRaw) as unknown;
        if (isLegacyProject(legacy)) migrateLegacyProject(seeded, legacy);
      }
    } catch {
      /* 旧稿损坏则忽略 */
    }
    // 迁移完成后旧稿归档，不再参与下次加载
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ migrated: true, at: new Date().toISOString() }));
    const initial = clone(seeded);
    // 迁移场景默认进入老师视角，方便看到归属结果
    if (initial.migration) initial.currentIdentityId = TEACHER_LIN_ID;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    return initial;
  }

  /** 测试/重置用：写入一份 v1 旧稿后重建工作区。 */
  reseedWithLegacy(legacy: unknown): Workspace {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacy));
    localStorage.removeItem(STORAGE_KEY);
    this.workspace = this.load();
    return this.workspace;
  }

  reset(): Workspace {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    this.workspace = this.load();
    return this.workspace;
  }

  persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.workspace));
  }

  // ── 身份 ───────────────────────────────────────────────────

  get identity(): Identity {
    return this.workspace.identities.find((item) => item.id === this.workspace.currentIdentityId)
      ?? this.workspace.identities[0];
  }

  get isLeader(): boolean {
    return this.identity.role === 'leader';
  }

  switchIdentity(id: string): void {
    this.workspace.currentIdentityId = id;
    this.persist();
  }

  setLibraryOnline(online: boolean): void {
    this.workspace.libraryOnline = online;
    this.persist();
  }

  // ── 查询 ───────────────────────────────────────────────────

  get libraryCourses(): LibraryCourse[] {
    return this.workspace.libraryCourses;
  }

  get personalCourses(): PersonalCourse[] {
    return this.workspace.personalCourses.filter((course) => course.ownerId === this.identity.id);
  }

  get requests(): BackfillRequest[] {
    return this.workspace.requests;
  }

  getLibraryCourse(id: string): LibraryCourse | undefined {
    return this.workspace.libraryCourses.find((course) => course.id === id);
  }

  getPersonalCourse(id: string): PersonalCourse | undefined {
    return this.workspace.personalCourses.find((course) => course.id === id);
  }

  findLibraryStep(courseId: string, stepId: string): { module: LibraryModule; step: LibraryStep } | undefined {
    const course = this.getLibraryCourse(courseId);
    for (const module of course?.modules ?? []) {
      const step = module.steps.find((item) => item.id === stepId);
      if (step) return { module, step };
    }
    return undefined;
  }

  // ── 权限：只有教研组长能写课程库 ───────────────────────────

  private requireLibraryOnline(): ActionResult | null {
    if (!this.workspace.libraryOnline) {
      return { ok: false, message: '课程库当前不可用，操作已被挡下；数据保留在本地，恢复后可继续。' };
    }
    return null;
  }

  private requireLeader(): ActionResult | null {
    if (this.identity.role !== 'leader') {
      return { ok: false, message: '越权操作已拦截：共享课程库只由教研组长维护，可先取用到个人课程再修改。' };
    }
    return null;
  }

  // ── 课程库：组长编辑工作稿 ─────────────────────────────────

  updateLibraryCourseMeta(courseId: string, patch: Partial<Pick<LibraryCourse, 'title' | 'summary' | 'audience'>>): ActionResult {
    const denied = this.requireLeader();
    if (denied) return denied;
    const course = this.getLibraryCourse(courseId);
    if (!course) return { ok: false, message: '课程不存在。' };
    Object.assign(course, patch);
    course.updatedAt = new Date().toISOString();
    this.persist();
    return { ok: true, message: '课程库课程信息已更新（待发布）。' };
  }

  updateLibraryStep(courseId: string, moduleId: string, stepId: string, patch: Partial<LessonStep>): ActionResult {
    const denied = this.requireLeader();
    if (denied) return denied;
    const course = this.getLibraryCourse(courseId);
    const module = course?.modules.find((item) => item.id === moduleId);
    const step = module?.steps.find((item) => item.id === stepId);
    if (!course || !module || !step) return { ok: false, message: '库步骤不存在。' };
    Object.assign(step, patch);
    course.updatedAt = new Date().toISOString();
    this.persist();
    return { ok: true, message: '标准步骤已更新，发布后对所有老师生效。' };
  }

  addLibraryModule(courseId: string): ActionResult {
    const denied = this.requireLeader();
    if (denied) return denied;
    const course = this.getLibraryCourse(courseId);
    if (!course) return { ok: false, message: '课程不存在。' };
    const module: LibraryModule = {
      id: uid('lib-mod'),
      title: `模块 ${course.modules.length + 1} · 未命名`,
      summary: '说明该模块的学习目标与适用场景。',
      color: ['#15827a', '#8a3ffc', '#b34331', '#376ea8'][course.modules.length % 4],
      steps: [],
    };
    course.modules.push(module);
    course.updatedAt = new Date().toISOString();
    this.persist();
    return { ok: true, message: '已在课程库新增模块（待发布）。' };
  }

  addLibraryStep(courseId: string, moduleId: string, kind: LessonStep['kind']): ActionResult {
    const denied = this.requireLeader();
    if (denied) return denied;
    const course = this.getLibraryCourse(courseId);
    const module = course?.modules.find((item) => item.id === moduleId);
    if (!course || !module) return { ok: false, message: '模块不存在。' };
    const prior = module.steps.at(-1);
    const step: LibraryStep = {
      id: uid('lib-step'),
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
      version: course.currentVersion + 1,
    };
    module.steps.push(step);
    course.updatedAt = new Date().toISOString();
    this.persist();
    return { ok: true, message: '已新增标准步骤（待发布）。' };
  }

  validateLibraryCourse(courseId: string): ValidationCheck[] {
    const course = this.getLibraryCourse(courseId);
    return course ? validateCourse(course) : [];
  }

  /** 教研组长发布课程库新版本：所有步骤版本号对齐到新版本。 */
  publishLibraryCourse(courseId: string, note: string): ActionResult {
    const deniedLeader = this.requireLeader();
    if (deniedLeader) return deniedLeader;
    const deniedOnline = this.requireLibraryOnline();
    if (deniedOnline) return deniedOnline;
    const course = this.getLibraryCourse(courseId);
    if (!course) return { ok: false, message: '课程不存在。' };
    const blocking = validateCourse(course).filter((check) => check.severity === 'error');
    if (blocking.length) return { ok: false, message: `发布被 ${blocking.length} 个阻断问题拦下，请先修复。` };

    const version = course.currentVersion + 1;
    course.modules.forEach((module) => module.steps.forEach((step) => { step.version = version; }));
    course.currentVersion = version;
    course.status = 'published';
    course.versions.unshift({
      version,
      label: `v${version} 发布`,
      note: note.trim() || '教研组更新标准步骤。',
      publishedAt: new Date().toISOString(),
      publishedBy: this.identity.name,
    });
    course.updatedAt = new Date().toISOString();

    // 发布后立刻让所有取用过这门课的老师个人副本对版本
    const upgradeSummary = this.upgradePersonalCopies(course);

    this.persist();
    return {
      ok: true,
      message: `课程库已发布 v${version}。${upgradeSummary.auto} 位老师名下未改动的步骤已自动升级，${upgradeSummary.conflict} 处老师自改步骤已转为待老师定夺。`,
    };
  }

  // ── 老师：从库里取一份到自己名下 ───────────────────────────

  checkoutFromLibrary(courseId: string): ActionResult {
    if (this.identity.role !== 'teacher') return { ok: false, message: '只有任课老师取用到个人课程。' };
    const course = this.getLibraryCourse(courseId);
    if (!course) return { ok: false, message: '课程库中没有这门课。' };
    const duplicate = this.workspace.personalCourses.find(
      (item) => item.ownerId === this.identity.id && item.libraryCourseId === courseId,
    );
    if (duplicate) return { ok: false, message: `你名下已经有《${duplicate.title}》的取用副本，请勿重复取用。` };

    const modules: PersonalModule[] = course.modules.map((module) => ({
      id: uid('p-mod'),
      libraryModuleId: module.id,
      title: module.title,
      summary: module.summary,
      color: module.color,
      steps: module.steps.map<PersonalStep>((step) => ({
        ...clone(step),
        libraryCourseId: course.id,
        originVersion: step.version,
        state: 'clean',
      })),
    }));
    const personal: PersonalCourse = {
      id: uid('p-course'),
      title: course.title,
      audience: course.audience,
      ownerId: this.identity.id,
      libraryCourseId: course.id,
      basedOnVersion: course.currentVersion,
      modules,
      conflicts: [],
      frozenVersions: [],
      lastSavedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    this.workspace.personalCourses.push(personal);
    this.persist();
    return { ok: true, message: `已把《${course.title}》v${course.currentVersion} 取用到你的个人课程，可在其中自由编学习步骤。` };
  }

  createPersonalCourse(): ActionResult {
    if (this.identity.role !== 'teacher') return { ok: false, message: '个人课程仅供老师创建。' };
    const course: PersonalCourse = {
      id: uid('p-course'),
      title: '未命名个人课程',
      audience: '',
      ownerId: this.identity.id,
      modules: [],
      conflicts: [],
      frozenVersions: [],
      lastSavedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    this.workspace.personalCourses.push(course);
    this.persist();
    return { ok: true, message: '已创建个人课程。' };
  }

  // ── 老师：编辑自己名下课程 ─────────────────────────────────

  private ownedPersonalCourse(courseId: string): PersonalCourse | undefined {
    const course = this.getPersonalCourse(courseId);
    return course && course.ownerId === this.identity.id ? course : undefined;
  }

  updatePersonalCourseMeta(courseId: string, patch: Partial<Pick<PersonalCourse, 'title' | 'audience'>>): ActionResult {
    const course = this.ownedPersonalCourse(courseId);
    if (!course) return { ok: false, message: '只能修改自己名下的课程。' };
    Object.assign(course, patch);
    course.lastSavedAt = new Date().toISOString();
    this.persist();
    return { ok: true, message: '个人课程信息已保存。' };
  }

  /**
   * 改步骤：clean 步骤第一次被老师改动即转 dirty，
   * 之后课程库升级不会悄悄覆盖它。
   */
  updatePersonalStep(courseId: string, moduleId: string, stepId: string, patch: Partial<LessonStep>): ActionResult {
    const course = this.ownedPersonalCourse(courseId);
    if (!course) return { ok: false, message: '只能修改自己名下的学习步骤。' };
    const module = course.modules.find((item) => item.id === moduleId);
    const step = module?.steps.find((item) => item.id === stepId);
    if (!module || !step) return { ok: false, message: '学习步骤不存在。' };

    // 若该步骤正处于未决冲突，直接编辑视为"用我的版本"；
    // 只登记裁定结果，不能用冲突时保存的快照覆盖老师刚刚输入的内容。
    const openConflict = course.conflicts.find((item) => item.stepId === stepId && !item.choice);
    Object.assign(step, patch);
    if (step.state === 'clean') step.state = 'dirty';
    if (openConflict) {
      openConflict.choice = 'mine';
      openConflict.resolvedAt = new Date().toISOString();
      openConflict.mineStep = clone(step);
    }
    course.lastSavedAt = new Date().toISOString();
    this.persist();
    return { ok: true, message: step.state === 'dirty' ? '步骤已修改；库版本升级时这一步不会被自动覆盖。' : '步骤已保存。' };
  }

  addPersonalModule(courseId: string): ActionResult {
    const course = this.ownedPersonalCourse(courseId);
    if (!course) return { ok: false, message: '只能在自己名下的课程中新增模块。' };
    course.modules.push({
      id: uid('p-mod'),
      title: `模块 ${course.modules.length + 1} · 自建`,
      summary: '个人课程自建模块。',
      color: '#376ea8',
      steps: [],
    });
    course.lastSavedAt = new Date().toISOString();
    this.persist();
    return { ok: true, message: '已新增个人模块。' };
  }

  addPersonalStep(courseId: string, moduleId: string, kind: LessonStep['kind']): ActionResult {
    const course = this.ownedPersonalCourse(courseId);
    const module = course?.modules.find((item) => item.id === moduleId);
    if (!course || !module) return { ok: false, message: '模块不存在。' };
    const prior = module.steps.at(-1);
    module.steps.push({
      id: uid('p-step'),
      title: `个人${kind}步骤 ${module.steps.length + 1}`,
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
      state: 'local',
    });
    course.lastSavedAt = new Date().toISOString();
    this.persist();
    return { ok: true, message: '已新增个人学习步骤。' };
  }

  movePersonalStep(courseId: string, moduleId: string, stepId: string, direction: -1 | 1): ActionResult {
    const course = this.ownedPersonalCourse(courseId);
    const module = course?.modules.find((item) => item.id === moduleId);
    if (!course || !module) return { ok: false, message: '模块不存在。' };
    const index = module.steps.findIndex((step) => step.id === stepId);
    const next = Math.max(0, Math.min(module.steps.length - 1, index + direction));
    if (index < 0 || index === next) return { ok: true, message: '顺序未变化。' };
    const [item] = module.steps.splice(index, 1);
    module.steps.splice(next, 0, item);
    course.lastSavedAt = new Date().toISOString();
    this.persist();
    return { ok: true, message: '已调整步骤顺序。' };
  }

  deletePersonalStep(courseId: string, moduleId: string, stepId: string): ActionResult {
    const course = this.ownedPersonalCourse(courseId);
    const module = course?.modules.find((item) => item.id === moduleId);
    if (!course || !module) return { ok: false, message: '模块不存在。' };
    module.steps = module.steps.filter((step) => step.id !== stepId);
    course.conflicts = course.conflicts.filter((conflict) => conflict.stepId !== stepId);
    course.lastSavedAt = new Date().toISOString();
    this.persist();
    return { ok: true, message: '已删除学习步骤。' };
  }

  validatePersonalCourse(courseId: string): ValidationCheck[] {
    const course = this.getPersonalCourse(courseId);
    return course ? validateCourse(course) : [];
  }

  // ── 发布升级：自动更新未动步骤，自改步骤转冲突 ─────────────

  /**
   * 对某门库课程的所有个人副本执行升级。
   * 规则：
   * - clean（没动过）：内容直接换成新版，originVersion 前进；
   * - dirty / resolved（动过）：库新内容与老师所持版本内容不同时绝不覆盖，
   *   生成冲突把两版摆出来；内容若已一致（例如回灌被采纳）则静默对齐；
   * - local：个人自建，永远不碰。
   */
  private upgradePersonalCopies(library: LibraryCourse): { auto: number; conflict: number } {
    let auto = 0;
    let conflict = 0;
    const newById = new Map<string, LibraryStep>();
    library.modules.forEach((module) => module.steps.forEach((step) => newById.set(step.id, step)));

    this.workspace.personalCourses.forEach((course) => {
      if (course.libraryCourseId !== library.id) return;
      course.modules.forEach((module) => {
        module.steps.forEach((step) => {
          if (step.state === 'local' || !step.libraryCourseId) return;
          const latest = newById.get(step.id);
          if (!latest) return; // 库里删除的步骤不强制处理
          if (step.state === 'clean') {
            Object.assign(step, {
              ...clone(latest),
              libraryCourseId: library.id,
              originVersion: latest.version,
              state: 'clean',
            } as PersonalStep);
            auto += 1;
            return;
          }
          // dirty / resolved：若老师手上的内容已经与库新版一致（例如回灌被采纳），
          // 直接对齐版本、回归 clean；否则保留老师内容并登记冲突。
          if (fingerprint(step) === fingerprint(latest)) {
            step.originVersion = latest.version;
            step.state = 'clean';
            return;
          }
          const alreadyOpen = course.conflicts.some((item) => item.stepId === step.id && !item.choice);
          if (!alreadyOpen) {
            course.conflicts.push({
              moduleId: module.id,
              stepId: step.id,
              libraryVersion: latest.version,
              libraryStep: clone(latest),
              mineStep: clone(step),
            });
            conflict += 1;
          }
        });
      });
      course.basedOnVersion = library.currentVersion;
    });
    return { auto, conflict };
  }

  /** 老师在冲突面板二选一：我的版本 / 库新版本。 */
  resolveConflict(courseId: string | PersonalCourse, moduleId: string, stepId: string, choice: ConflictChoice): ActionResult {
    const course = typeof courseId === 'string' ? this.ownedPersonalCourse(courseId) : courseId;
    if (!course) return { ok: false, message: '课程不可用。' };
    const record = course.conflicts.find((item) => item.moduleId === moduleId && item.stepId === stepId);
    if (!record) return { ok: false, message: '没有待处理的冲突。' };
    const step = course.modules.find((module) => module.id === moduleId)?.steps.find((item) => item.id === stepId);
    if (choice === 'library') {
      if (step) {
        const adopted: PersonalStep = {
          ...clone(record.libraryStep),
          libraryCourseId: course.libraryCourseId,
          originVersion: record.libraryVersion,
          state: 'resolved',
        };
        Object.assign(step, adopted);
      }
    } else {
      if (step) {
        Object.assign(step, clone(record.mineStep));
        step.state = 'resolved';
        step.originVersion = record.libraryVersion;
      }
    }
    record.choice = choice;
    record.resolvedAt = new Date().toISOString();
    course.lastSavedAt = new Date().toISOString();
    this.persist();
    return { ok: true, message: choice === 'library' ? '已采用课程库新版本覆盖该步骤。' : '已保留你的自改版本，不会再被自动替换。' };
  }

  // ── 回灌：老师申请把改好的步骤补进课程库 ───────────────────

  /**
   * 发起回灌：逐项生成申请条目。课程库不可用时，
   * 申请以 pending/failed 留在本地（"先把申请留住"），等恢复再补。
   */
  requestBackfill(courseId: string, note: string, stepIds: string[]): ActionResult {
    if (this.identity.role !== 'teacher') return { ok: false, message: '回灌申请由任课老师发起。' };
    const course = this.ownedPersonalCourse(courseId);
    if (!course || !course.libraryCourseId) return { ok: false, message: '这门个人课程没有对应的课程库，无法回灌。' };
    const picked: { module: PersonalModule; step: PersonalStep }[] = [];
    course.modules.forEach((module) => module.steps.forEach((step) => {
      if (stepIds.includes(step.id) && step.state !== 'local') picked.push({ module, step });
    }));
    if (picked.length === 0) return { ok: false, message: '请先勾选要回灌的标准学习步骤（个人自建步骤不回灌）。' };

    const items: BackfillItem[] = picked.map(({ module, step }) => ({
      id: uid('req-item'),
      libraryCourseId: course.libraryCourseId!,
      moduleId: module.libraryModuleId ?? module.id,
      stepId: step.id,
      stepTitle: step.title,
      payload: this.stripPersonal(step),
      status: 'pending',
      attempts: 0,
    }));

    const request: BackfillRequest = {
      id: uid('req'),
      courseId: course.id,
      courseTitle: course.title,
      teacherId: this.identity.id,
      teacherName: this.identity.name,
      note,
      createdAt: new Date().toISOString(),
      items,
    };
    this.workspace.requests.unshift(request);

    const online = this.workspace.libraryOnline;
    if (online) {
      this.applyRequestItems(request);
    } else {
      // 库中断：申请留住，全部挂起
      request.items.forEach((item) => { item.status = 'pending'; item.error = '课程库不可用，申请已留存，恢复后自动逐项补入。'; });
    }
    this.persist();
    return {
      ok: true,
      message: online
        ? `回灌申请已提交，${request.items.length} 个学习步骤已逐项补入课程库工作稿，等待教研组长审核发布。`
        : `课程库不可用：回灌申请（${request.items.length} 项）已保留，恢复连接后会自动按步骤逐项补上。`,
    };
  }

  private stripPersonal(step: PersonalStep): LessonStep {
    const { state: _state, originVersion: _v, libraryCourseId: _l, ...content } = step;
    return content;
  }

  /**
   * 把一份申请的条目逐项补进课程库工作稿（不是直接发布）。
   * 每一项独立成败：单项失败不影响其他项，失败项保留以便重试。
   */
  private applyRequestItems(request: BackfillRequest): { applied: number; failed: number } {
    let applied = 0;
    let failed = 0;
    request.items.forEach((item) => {
      if (item.status === 'applied' || item.status === 'rejected') return;
      item.attempts += 1;
      if (!this.workspace.libraryOnline) {
        item.status = 'failed';
        item.error = '课程库连接中断，该步骤暂未补入，已保留待重试。';
        failed += 1;
        return;
      }
      const located = this.findLibraryStep(item.libraryCourseId, item.stepId);
      if (!located) {
        item.status = 'failed';
        item.error = '课程库中找不到对应步骤，可能已被删除；恢复后请人工核对。';
        failed += 1;
        return;
      }
      // 只覆盖步骤内容，版本号保持当前发布版本；等组长发布新版本时统一切换，
      // 这样老师名下基于旧版本的步骤能正确识别到"库里变了"。
      // 同时留存补入前快照，组长退回该步时可完整还原。
      const { id: _id, ...content } = item.payload;
      item.preApplySnapshot = clone(located.step);
      Object.assign(located.step, content);
      item.status = 'applied';
      item.appliedVersion = (this.getLibraryCourse(item.libraryCourseId)?.currentVersion ?? 0) + 1;
      delete item.error;
      applied += 1;
    });
    return { applied, failed };
  }

  /** 课程库恢复后调用：把所有 pending/failed 申请按学习步骤逐项补上。 */
  retryPendingBackfills(): ActionResult {
    if (!this.workspace.libraryOnline) return { ok: false, message: '课程库仍未恢复，申请继续保留。' };
    let applied = 0;
    let stillFailing = 0;
    this.workspace.requests.forEach((request) => {
      const result = this.applyRequestItems(request);
      applied += result.applied;
      stillFailing += result.failed;
    });
    this.persist();
    if (applied === 0 && stillFailing === 0) return { ok: true, message: '当前没有待补的回灌申请。' };
    return {
      ok: stillFailing === 0,
      message: stillFailing === 0
        ? `课程库恢复后已把留存的 ${applied} 个学习步骤逐项补入工作稿，等待教研组长发布。`
        : `已补入 ${applied} 项，仍有 ${stillFailing} 项失败并继续保留。`,
    };
  }

  /** 教研组长对已补入工作稿的单项回灌做通过/退回（不影响其他步骤）。 */
  reviewBackfillItem(requestId: string, itemId: string, approve: boolean, reason = ''): ActionResult {
    const denied = this.requireLeader();
    if (denied) return denied;
    const request = this.workspace.requests.find((item) => item.id === requestId);
    const item = request?.items.find((entry) => entry.id === itemId);
    if (!request || !item) return { ok: false, message: '回灌条目不存在。' };
    if (!approve) {
      // 退回：用补入前快照把库工作稿的这一步还原，其他回灌步骤不受影响。
      const located = this.findLibraryStep(item.libraryCourseId, item.stepId);
      if (located && item.preApplySnapshot) {
        const { id: _id, ...snapshot } = item.preApplySnapshot;
        Object.assign(located.step, snapshot);
      }
      item.status = 'rejected';
      item.error = reason || '与标准课程方向不一致，已退回该步骤。';
      item.reviewedAt = new Date().toISOString();
      item.reviewedBy = this.identity.name;
      this.persist();
      return { ok: true, message: `已退回「${item.stepTitle}」并还原库工作稿原内容，其他回灌步骤不受影响。` };
    }
    item.status = 'applied';
    item.reviewedAt = new Date().toISOString();
    item.reviewedBy = this.identity.name;
    this.persist();
    return { ok: true, message: `「${item.stepTitle}」已确认，随下次发布进入课程库新版本。` };
  }

  // ── 供 UI 展示的派生信息 ───────────────────────────────────

  /** 某位老师名下课程相对课程库的版本差距与未决冲突数。 */
  courseUpgradeStatus(courseId: string): { behind: number; conflicts: number; libraryVersion: number } {
    const course = this.getPersonalCourse(courseId);
    const library = course?.libraryCourseId ? this.getLibraryCourse(course.libraryCourseId) : undefined;
    const conflicts = course?.conflicts.filter((item) => !item.choice).length ?? 0;
    const behind = library && course ? Math.max(0, library.currentVersion - (course.basedOnVersion ?? 0)) : 0;
    return { behind, conflicts, libraryVersion: library?.currentVersion ?? 0 };
  }

  /** 手动触发一次升级对齐（老师主动"检查库更新"时使用）。 */
  pullLibraryUpdates(courseId: string): ActionResult {
    const course = this.ownedPersonalCourse(courseId);
    if (!course || !course.libraryCourseId) return { ok: false, message: '这门课没有关联课程库。' };
    const library = this.getLibraryCourse(course.libraryCourseId);
    if (!library) return { ok: false, message: '课程库中找不到来源课程。' };
    if ((course.basedOnVersion ?? 0) >= library.currentVersion) {
      return { ok: true, message: '已经是课程库最新版本。' };
    }
    const result = this.upgradePersonalCopies(library);
    this.persist();
    return {
      ok: true,
      message: `对齐到 v${library.currentVersion}：${result.auto} 个未改动步骤已自动升级，${result.conflict} 个自改步骤需要你定夺。`,
    };
  }
}

/** 测试辅助：构造一条标准学习步骤。 */
export function makeStep(overrides: Partial<LessonStep> & Pick<LessonStep, 'id' | 'title'>): LessonStep {
  return {
    kind: '示范',
    duration: 40,
    demoTitle: '',
    demoUrl: '',
    handshape: '',
    gestureZone: '中央',
    caption: '',
    captionPosition: '下方安全区',
    camera: '正面',
    commonMistakes: [],
    exercise: '',
    exerciseFeedback: '',
    altText: '替代文本',
    prerequisiteId: '',
    difficulty: '入门',
    cuePoints: [],
    ...overrides,
  };
}

export function makeModule(id: string, title: string, steps: LessonStep[]): CourseModule {
  return { id, title, summary: '', color: '#15827a', steps };
}

export type {
  BackfillItem,
  BackfillRequest,
  LessonStep,
  LibraryCourse,
  LibraryStep,
  PersonalCourse,
  PersonalStep,
  StepConflict,
  Workspace,
};

export { TEACHER_LIN_ID, fingerprint };
