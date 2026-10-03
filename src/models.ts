// ─────────────────────────────────────────────────────────────
// 领域模型：共享课程库 + 老师个人课程 + 回灌申请
// ─────────────────────────────────────────────────────────────

export type Role = 'leader' | 'teacher';

export type Difficulty = '入门' | '进阶' | '挑战';
export type CameraAngle = '正面' | '左侧 45°' | '右侧 45°' | '俯拍手部' | '全身远景';
export type CaptionPosition = '下方安全区' | '上移 15%' | '角标提示' | '画面中央';
export type GestureZone = '左侧' | '中央' | '右侧';

/** 学习步骤内容：课程库版本与个人副本共用同一形状，便于逐项比对。 */
export interface LessonStep {
  id: string;
  title: string;
  kind: '示范' | '讲解' | '练习';
  duration: number;
  demoTitle: string;
  demoUrl: string;
  handshape: string;
  gestureZone: GestureZone;
  caption: string;
  captionPosition: CaptionPosition;
  camera: CameraAngle;
  commonMistakes: string[];
  exercise: string;
  exerciseFeedback: string;
  altText: string;
  prerequisiteId: string;
  difficulty: Difficulty;
  cuePoints: number[];
}

export interface CourseModule {
  id: string;
  title: string;
  summary: string;
  color: string;
  steps: LessonStep[];
}

// ── 共享课程库 ────────────────────────────────────────────────

/** 库里每个步骤带一个随发布增长的版本号，个人副本据此判断升级。 */
export interface LibraryStep extends LessonStep {
  version: number;
}

export interface LibraryModule {
  id: string;
  title: string;
  summary: string;
  color: string;
  steps: LibraryStep[];
}

export interface CourseVersion {
  version: number;
  label: string;
  note: string;
  publishedAt: string;
  publishedBy: string;
}

export type PublishStatus = 'draft' | 'published';

export interface LibraryCourse {
  id: string;
  title: string;
  summary: string;
  audience: string;
  ownerId: string;
  status: PublishStatus;
  /** 当前发布版本号；工作稿可继续在其上修改，发布时再 +1。 */
  currentVersion: number;
  modules: LibraryModule[];
  versions: CourseVersion[];
  createdAt: string;
  updatedAt: string;
}

// ── 老师个人课程 ──────────────────────────────────────────────

/**
 * 个人步骤的跟踪状态：
 * - clean：取用后没有动过，课程库发布新版本时内容自动升级
 * - dirty：老师改过，发布新版本时不覆盖，转成 conflict 摆出两版
 * - local：个人自建、库里没有对应步骤，升级流程不触碰
 * - resolved：冲突已由老师定夺（采纳了其中一版）
 */
export type PersonalStepState = 'clean' | 'dirty' | 'local' | 'resolved';

export interface PersonalStep extends LessonStep {
  libraryCourseId?: string;
  /** 该步骤内容对应的库步骤版本；local 步骤没有。 */
  originVersion?: number;
  state: PersonalStepState;
}

export interface PersonalModule {
  id: string;
  libraryModuleId?: string;
  title: string;
  summary: string;
  color: string;
  steps: PersonalStep[];
}

export type ConflictChoice = 'mine' | 'library';

export interface StepConflict {
  moduleId: string;
  stepId: string;
  libraryVersion: number;
  libraryStep: LessonStep;
  /** 老师在冲突发生那一刻保留的自改版。 */
  mineStep: LessonStep;
  choice?: ConflictChoice;
  resolvedAt?: string;
}

export interface PersonalCourse {
  id: string;
  title: string;
  audience: string;
  ownerId: string;
  /** 来源课程库；个人从零创建时为空。 */
  libraryCourseId?: string;
  /** 最近一次对到的库版本。 */
  basedOnVersion?: number;
  modules: PersonalModule[];
  conflicts: StepConflict[];
  frozenVersions: { id: string; label: string; createdAt: string }[];
  lastSavedAt: string;
  createdAt: string;
}

// ── 回灌申请 ──────────────────────────────────────────────────

export type RequestItemStatus =
  | 'pending'    // 等待课程库接收（库中断时先留住）
  | 'applied'    // 已按学习步骤逐项补进课程库工作稿
  | 'rejected'   // 教研组长退回该步骤
  | 'failed';    // 补库时单项失败，库恢复后重试

export interface BackfillItem {
  id: string;
  libraryCourseId: string;
  moduleId: string;
  stepId: string;
  stepTitle: string;
  /** 老师申请回灌时的步骤内容快照。 */
  payload: LessonStep;
  /** 补入库工作稿前的原步骤内容；组长退回时据此还原。 */
  preApplySnapshot?: LessonStep;
  status: RequestItemStatus;
  error?: string;
  attempts: number;
  appliedVersion?: number;
  reviewedAt?: string;
  reviewedBy?: string;
}

export interface BackfillRequest {
  id: string;
  courseId: string;
  courseTitle: string;
  teacherId: string;
  teacherName: string;
  note: string;
  createdAt: string;
  items: BackfillItem[];
}

// ── 身份与工作区 ──────────────────────────────────────────────

export interface Identity {
  id: string;
  name: string;
  role: Role;
  title: string;
}

export interface MigrationRecord {
  at: string;
  detail: string;
  personalCourseId: string;
  personalCourseTitle: string;
  ownerName: string;
  linkedSteps: number;
  localSteps: number;
}

export interface Workspace {
  version: 2;
  identities: Identity[];
  currentIdentityId: string;
  libraryCourses: LibraryCourse[];
  personalCourses: PersonalCourse[];
  requests: BackfillRequest[];
  /** 课程库连接状态；断开时写库操作失败但申请保留。 */
  libraryOnline: boolean;
  migration?: MigrationRecord;
}

export interface ValidationCheck {
  id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  stepId?: string;
  moduleId?: string;
}

// ── 本地存储 ──────────────────────────────────────────────────

export const STORAGE_KEY = 'sologsb-1012-sign-course-workspace-v2';
export const LEGACY_STORAGE_KEY = 'sologsb-1012-sign-course-project-v1';

// ── 内容指纹：判断老师名下步骤是否"没动过" ───────────────────

const FINGERPRINT_FIELDS: (keyof LessonStep)[] = [
  'title', 'kind', 'duration', 'demoTitle', 'demoUrl', 'handshape', 'gestureZone',
  'caption', 'captionPosition', 'camera', 'commonMistakes', 'exercise',
  'exerciseFeedback', 'altText', 'prerequisiteId', 'difficulty', 'cuePoints',
];

export function fingerprint(step: LessonStep): string {
  return JSON.stringify(FINGERPRINT_FIELDS.map((field) => step[field]));
}

export function stepsEqual(a: LessonStep, b: LessonStep): boolean {
  return fingerprint(a) === fingerprint(b);
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

// ── 校验（库课程与个人课程结构一致，通用） ───────────────────

type AnyModule = { id: string; title: string; steps: LessonStep[] };
type AnyCourse = { title: string; modules: AnyModule[] };

export function validateCourse(course: AnyCourse): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  if (!course.title.trim()) checks.push({ id: 'title', severity: 'error', title: '课程标题缺失', detail: '发布前需要为课程填写清晰标题。' });
  if (course.modules.length === 0) checks.push({ id: 'modules', severity: 'error', title: '没有课程模块', detail: '至少需要创建一个包含学习步骤的模块。' });

  course.modules.forEach((module) => {
    if (!module.steps.length) {
      checks.push({ id: `empty-${module.id}`, severity: 'error', title: `${module.title} 没有学习步骤`, detail: '空模块无法进入复核。', moduleId: module.id });
    }
    module.steps.forEach((step, index) => {
      if (!step.altText.trim()) {
        checks.push({ id: `alt-${step.id}`, severity: 'error', title: `${step.title} 缺少替代文本`, detail: '示范片段需要描述手形、移动和面部表情。', stepId: step.id, moduleId: module.id });
      }
      if (!step.caption.trim()) {
        checks.push({ id: `caption-${step.id}`, severity: 'warning', title: `${step.title} 缺少字幕`, detail: '听障学习者在静音预览时无法获得说明。', stepId: step.id, moduleId: module.id });
      }
      if (step.captionPosition === '画面中央' && (step.gestureZone === '中央' || step.camera === '俯拍手部')) {
        checks.push({ id: `overlap-${step.id}`, severity: 'error', title: `${step.title} 字幕可能遮挡动作`, detail: `字幕位于${step.captionPosition}，而主要手形位于${step.gestureZone}。`, stepId: step.id, moduleId: module.id });
      }
      if (step.duration < 20) {
        checks.push({ id: `duration-${step.id}`, severity: 'warning', title: `${step.title} 时长过短`, detail: '示范与练习不足 20 秒，学习者来不及观察和跟做。', stepId: step.id, moduleId: module.id });
      }
      if (step.prerequisiteId) {
        const prerequisiteIndex = module.steps.findIndex((candidate) => candidate.id === step.prerequisiteId);
        if (prerequisiteIndex < 0) {
          checks.push({ id: `missing-pre-${step.id}`, severity: 'error', title: `${step.title} 的前置步骤不存在`, detail: '请重新选择前置条件或移除依赖。', stepId: step.id, moduleId: module.id });
        } else if (prerequisiteIndex >= index) {
          checks.push({ id: `jump-${step.id}`, severity: 'error', title: `${step.title} 出现步骤跳级`, detail: '前置步骤位于当前步骤之后，学习顺序无法成立。', stepId: step.id, moduleId: module.id });
        }
      }
      if (step.kind === '练习' && (!step.exercise.trim() || !step.exerciseFeedback.trim())) {
        checks.push({ id: `practice-${step.id}`, severity: 'warning', title: `${step.title} 的练习反馈不完整`, detail: '练习任务需要明确完成动作和即时反馈方式。', stepId: step.id, moduleId: module.id });
      }
      if (step.commonMistakes.filter(Boolean).length === 0) {
        checks.push({ id: `mistakes-${step.id}`, severity: 'info', title: `${step.title} 尚未记录常见错误`, detail: '补充常见错误有助于教师现场提示。', stepId: step.id, moduleId: module.id });
      }
    });
  });

  return checks;
}

// ── 种子数据：教研组标准课程 ─────────────────────────────────

export const LEADER_ID = 'leader-chen';
export const TEACHER_LIN_ID = 'teacher-lin';
export const TEACHER_WANG_ID = 'teacher-wang';

function seedSteps(): { m1: CourseModule[]; m2: CourseModule[] } {
  const m1: CourseModule = {
    id: 'lib-mod-greeting',
    title: '模块一 · 日常问候',
    summary: '建立手形、视线和面部表情之间的配合，完成三个基础问候。',
    color: '#15827a',
    steps: [
      {
        id: 'lib-step-hello-watch',
        title: '观察“你好”的完整动作',
        kind: '示范',
        duration: 35,
        demoTitle: '你好 · 正面慢速示范',
        demoUrl: '',
        handshape: '右手掌张开，拇指向上，自额头向外送出',
        gestureZone: '右侧',
        caption: '你好：手掌从额前向前送出，同时保持微笑。',
        captionPosition: '下方安全区',
        camera: '正面',
        commonMistakes: ['手掌过于僵硬', '没有视线交流'],
        exercise: '跟随示范完成两次，每次保持两秒。',
        exerciseFeedback: '镜面检查手掌高度是否与眉线一致。',
        altText: '教师面向镜头，用右手掌从额头向前送出，并点头微笑。',
        prerequisiteId: '',
        difficulty: '入门',
        cuePoints: [4, 16, 28],
      },
      {
        id: 'lib-step-hello-breakdown',
        title: '拆解“你好”的手形',
        kind: '讲解',
        duration: 50,
        demoTitle: '你好 · 手部近景',
        demoUrl: '',
        handshape: '四指并拢，拇指张开；掌心朝左前侧',
        gestureZone: '中央',
        caption: '注意四指并拢，动作沿身体中轴向前。',
        captionPosition: '下方安全区',
        camera: '俯拍手部',
        commonMistakes: [],
        exercise: '固定肩部，只移动前臂完成五次。',
        exerciseFeedback: '如果动作跑偏，先在镜前标记起点和终点。',
        altText: '手部近景展示四指并拢、拇指张开的起始手形。',
        prerequisiteId: 'lib-step-hello-watch',
        difficulty: '入门',
        cuePoints: [6, 24, 42],
      },
      {
        id: 'lib-step-hello-pair',
        title: '双人问候练习',
        kind: '练习',
        duration: 75,
        demoTitle: '你好 · 双人轮流练习',
        demoUrl: '',
        handshape: '保持标准手形，配合点头与视线交换',
        gestureZone: '中央',
        caption: '轮流问候，每次动作结束后停一拍，再交换角色。',
        captionPosition: '上移 15%',
        camera: '全身远景',
        commonMistakes: ['动作过早结束', '两人视线没有相遇'],
        exercise: '两人一组轮流完成问候，交换三次。',
        exerciseFeedback: '同伴负责确认视线和动作停顿。',
        altText: '两名学习者相对站立，交替做出问候动作并看向对方。',
        prerequisiteId: 'lib-step-hello-breakdown',
        difficulty: '进阶',
        cuePoints: [10, 34, 57],
      },
    ],
  };
  const m2: CourseModule = {
    id: 'lib-mod-number',
    title: '模块二 · 数量表达',
    summary: '用数字、空间位置和顺序词完成价格询问。',
    color: '#8a3ffc',
    steps: [
      {
        id: 'lib-step-number-hand',
        title: '数字一到五的稳定手形',
        kind: '讲解',
        duration: 60,
        demoTitle: '数字 1—5 · 镜面视图',
        demoUrl: '',
        handshape: '食指到五指依次展开，手心朝前',
        gestureZone: '中央',
        caption: '数字一到五：从食指开始依次增加，不移动手腕。',
        captionPosition: '下方安全区',
        camera: '正面',
        commonMistakes: ['拇指遮挡手指数', '手腕左右摆动'],
        exercise: '按随机口令连续展示 1—5。',
        exerciseFeedback: '每个数字保持一秒，同伴随机报数。',
        altText: '教师手心朝前，依次伸出食指到五指，展示数字一到五。',
        prerequisiteId: '',
        difficulty: '入门',
        cuePoints: [8, 26, 44],
      },
      {
        id: 'lib-step-how-much',
        title: '组合成“多少钱”',
        kind: '示范',
        duration: 45,
        demoTitle: '多少钱 · 双手组合动作',
        demoUrl: '',
        handshape: '双手在胸前交替翻转，随后食指向前点出',
        gestureZone: '中央',
        caption: '先做“钱”的交替手形，再用食指向前询问。',
        captionPosition: '角标提示',
        camera: '右侧 45°',
        commonMistakes: ['两手动作不同步', '疑问表情缺失'],
        exercise: '配合疑问表情完成三次询问。',
        exerciseFeedback: '录下动作，检查双手是否在胸前同一高度。',
        altText: '教师双手机械交替翻转后，食指朝前点出并抬眉疑问。',
        prerequisiteId: 'lib-step-number-hand',
        difficulty: '进阶',
        cuePoints: [5, 22, 37],
      },
    ],
  };
  return { m1: [m1], m2: [m2] };
}

export function createSeedWorkspace(): Workspace {
  const seed = seedSteps();
  const greeting = seed.m1;
  const number = seed.m2;
  const now = new Date().toISOString();
  const libraryCourse: LibraryCourse = {
    id: 'lib-course-greeting-number',
    title: '零基础手语 · 问候与数量（标准课程）',
    summary: '教研组统一维护的入门标准课程，覆盖问候与数量表达两个模块。',
    audience: '初次接触手语的初中学习者',
    ownerId: LEADER_ID,
    status: 'published',
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
    modules: [...greeting, ...number].map((module) => ({
      ...module,
      steps: module.steps.map((step) => ({ ...step, version: 1 })),
    })),
    versions: [
      { version: 1, label: 'v1 初版发布', note: '教研组整理的问候与数量标准步骤。', publishedAt: now, publishedBy: '陈组长' },
    ],
  };
  return {
    version: 2,
    identities: [
      { id: LEADER_ID, name: '陈组长', role: 'leader', title: '教研组长 · 课程库维护人' },
      { id: TEACHER_LIN_ID, name: '林老师', role: 'teacher', title: '特殊教育中心 · 一线教师' },
      { id: TEACHER_WANG_ID, name: '王老师', role: 'teacher', title: '特教教研组 · 一线教师' },
    ],
    currentIdentityId: TEACHER_LIN_ID,
    libraryCourses: [libraryCourse],
    personalCourses: [],
    requests: [],
    libraryOnline: true,
  };
}

// ── 旧数据迁移：把 v1 单人稿按归属迁到老师个人名下 ──────────

interface LegacyProject {
  id: string;
  title: string;
  teacher: string;
  audience: string;
  status: string;
  selectedModuleId: string;
  selectedStepId: string;
  modules: CourseModule[];
  frozenVersions: { id: string; label: string; createdAt: string; snapshot?: unknown }[];
  lastSavedAt: string;
  revision: number;
}

export function isLegacyProject(value: unknown): value is LegacyProject {
  const candidate = value as LegacyProject | null;
  return Boolean(candidate && typeof candidate === 'object' && Array.isArray(candidate.modules));
}

/**
 * 迁移规则：
 * - 旧稿是某位老师个人所编，整体迁入该老师个人课程，课程库保持教研组长独立维护；
 * - 与库里已发布步骤逐项指纹一致的，记为 clean 并挂上库版本（之后能跟随升级）；
 * - 其余步骤记为 local，属于老师个人内容，升级与回灌之外不被动到；
 * - 前置依赖若指向已换 id 的库步骤，按内容指纹重新接线。
 */
export function migrateLegacyProject(workspace: Workspace, legacy: LegacyProject): MigrationRecord {
  const teachers = workspace.identities.filter((identity) => identity.role === 'teacher');
  const owner = teachers.find((identity) => legacy.teacher.includes(identity.name))
    ?? teachers.find((identity) => legacy.teacher.includes(identity.name.slice(0, 1)))
    ?? teachers[0]
    ?? workspace.identities[0];

  const libraryCourse = workspace.libraryCourses[0];
  const publishedIndex = new Map<string, { moduleId: string; step: LibraryStep }>();
  libraryCourse?.modules.forEach((module) => module.steps.forEach((step) => {
    publishedIndex.set(fingerprint(step), { moduleId: module.id, step });
  }));

  // 旧步骤 id → 库步骤 id，用于重写前置依赖
  const idRemap = new Map<string, string>();
  let linkedSteps = 0;
  let localSteps = 0;

  const modules: PersonalModule[] = legacy.modules.map((module) => ({
    id: uid('p-mod'),
    title: module.title,
    summary: module.summary,
    color: module.color,
    steps: module.steps.map((step) => {
      const match = publishedIndex.get(fingerprint(step));
      if (match) {
        idRemap.set(step.id, match.step.id);
        linkedSteps += 1;
        const personal: PersonalStep = {
          ...step,
          id: match.step.id,
          libraryCourseId: libraryCourse.id,
          originVersion: match.step.version,
          state: 'clean',
        };
        return personal;
      }
      localSteps += 1;
      const personal: PersonalStep = { ...step, id: uid('p-step'), state: 'local' };
      idRemap.set(step.id, personal.id);
      return personal;
    }),
  }));

  // 第二遍：重写前置步骤引用
  modules.forEach((module) => module.steps.forEach((step) => {
    if (step.prerequisiteId && idRemap.has(step.prerequisiteId)) {
      step.prerequisiteId = idRemap.get(step.prerequisiteId)!;
    }
  }));

  const now = new Date().toISOString();
  const personal: PersonalCourse = {
    id: uid('p-course'),
    title: legacy.title,
    audience: legacy.audience,
    ownerId: owner.id,
    libraryCourseId: libraryCourse?.id,
    basedOnVersion: libraryCourse?.currentVersion,
    modules,
    conflicts: [],
    frozenVersions: (legacy.frozenVersions ?? []).map((frozen) => ({ id: frozen.id, label: frozen.label, createdAt: frozen.createdAt })),
    lastSavedAt: legacy.lastSavedAt || now,
    createdAt: legacy.lastSavedAt || now,
  };
  workspace.personalCourses.push(personal);

  const record: MigrationRecord = {
    at: now,
    detail: `旧版单人本地稿《${legacy.title}》按归属迁移至 ${owner.name} 名下；与课程库 v${libraryCourse?.currentVersion ?? 1} 一致的 ${linkedSteps} 个步骤已挂接为标准步骤，${localSteps} 个个人步骤保留为本地步骤。`,
    personalCourseId: personal.id,
    personalCourseTitle: personal.title,
    ownerName: owner.name,
    linkedSteps,
    localSteps,
  };
  workspace.migration = record;
  return record;
}

/**
 * 重构前的 v1 单人本地稿（与旧 STORAGE_KEY 对应）。
 * 首次进入新系统时用它演示"按归属迁移"：4 个步骤与课程库一致会挂接为
 * clean 标准步骤，1 个被老师调过的步骤成为个人 local 步骤。
 */
export function createDemoLegacyProject(): LegacyProject {
  const seed = seedSteps();
  const [greeting] = seed.m1;
  const [numberModule] = seed.m2;
  const modules: CourseModule[] = [
    {
      ...greeting,
      id: 'module-1',
      steps: [
        // 老师在旧稿里调过第一步：与库内容不同，迁移后属于个人步骤
        {
          ...greeting.steps[0],
          id: 'step-1-1',
          handshape: '右手掌张开，拇指向上，自额头向外平缓送出并略作停顿（林老师课堂调整）',
        },
        { ...greeting.steps[1], id: 'step-1-2' },
        { ...greeting.steps[2], id: 'step-1-3' },
      ],
    },
    {
      ...numberModule,
      id: 'module-2',
      steps: numberModule.steps.map((step, index) => ({ ...step, id: `step-2-${index + 1}` })),
    },
  ];

  return {
    id: 'sign-course-project',
    title: '零基础手语 · 问候与数量',
    teacher: '林老师 / 特殊教育中心',
    audience: '初次接触手语的初中学习者',
    status: 'draft',
    selectedModuleId: 'module-1',
    selectedStepId: 'step-1-2',
    modules,
    frozenVersions: [],
    lastSavedAt: new Date().toISOString(),
    revision: 7,
  };
}
