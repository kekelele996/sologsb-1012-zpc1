export type CourseStatus = 'draft' | 'review' | 'changes' | 'frozen';
export type Difficulty = '入门' | '进阶' | '挑战';
export type CameraAngle = '正面' | '左侧 45°' | '右侧 45°' | '俯拍手部' | '全身远景';
export type CaptionPosition = '下方安全区' | '上移 15%' | '角标提示' | '画面中央';
export type GestureZone = '左侧' | '中央' | '右侧';

export type Role = 'leader' | 'teacher';

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

/* ---------------- 共享课程库 ---------------- */

export type LibraryCourseStatus = 'draft' | 'published';

export interface CourseVersion {
  version: number;
  label: string;
  publishedAt: string;
  note: string;
  modules: CourseModule[];
}

export interface LibraryCourse {
  id: string;
  title: string;
  audience: string;
  color: string;
  /** 教研组长维护中的标准课程草稿，发布后固化为 CourseVersion */
  draftModules: CourseModule[];
  status: LibraryCourseStatus;
  versions: CourseVersion[];
  publishedVersion: number;
  createdAt: string;
  updatedAt: string;
}

/* ---------------- 老师个人课程 ---------------- */

/** clean：未改动，随库升级；modified：老师改过；conflict：库也改了同一处，等老师裁定；new：老师自建 */
export type StepState = 'clean' | 'modified' | 'conflict' | 'new';
export type ModuleState = 'clean' | 'modified' | 'new';

export interface PersonalStep extends LessonStep {
  /** 库中对应步骤 id；老师自建步骤为空字符串 */
  sourceStepId: string;
  state: StepState;
  /** 库里的对应步骤已被删除，但老师本地改过，保留待老师决定 */
  upstreamDeleted?: boolean;
  /** 升级后两版都动过：库的新版本摆在这里，等老师裁定 */
  upstreamStep?: LessonStep;
  /** 最近一次成功回灌时的内容指纹；没有新改动的步骤不再重复进申请 */
  backfilledSignature?: string;
}

export interface PersonalModule {
  id: string;
  sourceModuleId: string;
  title: string;
  summary: string;
  color: string;
  state: ModuleState;
  steps: PersonalStep[];
  /** 老师主动删掉的库步骤，升级时不再补回 */
  droppedStepIds?: string[];
  /** 库里整个模块已删除，但老师本地改过，保留待老师决定 */
  upstreamDeleted?: boolean;
}

export interface TeacherCopy {
  id: string;
  libraryCourseId: string;
  title: string;
  teacherId: string;
  teacherName: string;
  audience: string;
  color: string;
  /** 取课时对应的库版本；升级到冲突全部裁定后再推进 */
  sourceVersion: number;
  modules: PersonalModule[];
  lastSavedAt: string;
  revision: number;
  lastSyncNotice?: string;
}

/* ---------------- 回灌申请 ---------------- */

export type BackfillItemState = 'queued' | 'applied' | 'failed';

export interface BackfillItem {
  id: string;
  /** 该步骤在老师副本里的 id，回写同步状态用 */
  copyStepId: string;
  copyId: string;
  sourceModuleId: string;
  moduleTitle: string;
  sourceStepId: string;
  /** 申请时的步骤内容快照 */
  step: LessonStep;
  /** 老师自建步骤回灌成功后，库里分配给它的新步骤 id */
  assignedLibraryStepId?: string;
  /** 申请时的内容指纹，成功后回写到副本，避免同一内容重复回灌 */
  signature: string;
  /** 插入位置提示：排在哪个步骤之后（空表示排到模块末尾） */
  afterStepId: string;
  state: BackfillItemState;
  message?: string;
}

export type BackfillRequestStatus = 'pending' | 'applied' | 'rejected';

export interface BackfillRequest {
  id: string;
  libraryCourseId: string;
  copyId: string;
  courseTitle: string;
  teacherId: string;
  teacherName: string;
  note: string;
  createdAt: string;
  status: BackfillRequestStatus;
  items: BackfillItem[];
}

/* ---------------- 工作区（本地持久化） ---------------- */

export interface WorkspaceUser {
  id: string;
  name: string;
  role: Role;
}

export interface Workspace {
  schema: 2;
  currentUserId: string;
  users: WorkspaceUser[];
  library: LibraryCourse[];
  copies: TeacherCopy[];
  backfills: BackfillRequest[];
  /** 课程库是否可写（离线/故障模拟）；个人副本始终可在本地编辑 */
  libraryOnline: boolean;
}

export interface ValidationCheck {
  id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  stepId?: string;
  moduleId?: string;
}

export const LEGACY_STORAGE_KEY = 'sologsb-1012-sign-course-project-v1';
export const WORKSPACE_STORAGE_KEY = 'sologsb-1012-workspace-v2';

/* ---------------- 示例数据 ---------------- */

export function createDemoModules(): CourseModule[] {
  const modules: CourseModule[] = [
    {
      id: 'module-1',
      title: '模块一 · 日常问候',
      summary: '建立手形、视线和面部表情之间的配合，完成三个基础问候。',
      color: '#15827a',
      steps: [
        {
          id: 'step-1-1',
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
          id: 'step-1-2',
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
          commonMistakes: ['拇指贴住掌心', '动作方向偏向一侧'],
          exercise: '固定肩部，只移动前臂完成五次。',
          exerciseFeedback: '如果动作跑偏，先在镜前标记起点和终点。',
          altText: '手部近景展示四指并拢、拇指张开的起始手形。',
          prerequisiteId: 'step-1-1',
          difficulty: '入门',
          cuePoints: [6, 24, 42],
        },
        {
          id: 'step-1-3',
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
          exerciseFeedback: '同伴负责确认视线和停顿。',
          altText: '两名学习者相对站立，交替做出问候动作并看向对方。',
          prerequisiteId: 'step-1-2',
          difficulty: '进阶',
          cuePoints: [10, 34, 57],
        },
      ],
    },
    {
      id: 'module-2',
      title: '模块二 · 数量表达',
      summary: '用数字、空间位置和顺序词完成价格询问。',
      color: '#8a3ffc',
      steps: [
        {
          id: 'step-2-1',
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
          id: 'step-2-2',
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
          prerequisiteId: 'step-2-1',
          difficulty: '进阶',
          cuePoints: [5, 22, 37],
        },
      ],
    },
  ];
  return modules;
}

/** 兼容旧版本读取：v1 本地稿结构（迁移后删除） */
export interface LegacyProject {
  id?: string;
  title?: string;
  teacher?: string;
  audience?: string;
  status?: CourseStatus;
  modules?: CourseModule[];
  frozenVersions?: { id: string; label: string; createdAt: string; snapshot: { title?: string; audience?: string; modules: CourseModule[] } }[];
  lastSavedAt?: string;
}

/* ---------------- 内容比较 ---------------- */

const STEP_CONTENT_KEYS: (keyof LessonStep)[] = [
  'title', 'kind', 'duration', 'demoTitle', 'demoUrl', 'handshape', 'gestureZone',
  'caption', 'captionPosition', 'camera', 'commonMistakes', 'exercise',
  'exerciseFeedback', 'altText', 'prerequisiteId', 'difficulty', 'cuePoints',
];

export function stepsContentEqual(a: LessonStep, b: LessonStep): boolean {
  return STEP_CONTENT_KEYS.every((key) => {
    const av = a[key] as unknown;
    const bw = b[key] as unknown;
    return typeof av === 'object' ? JSON.stringify(av) === JSON.stringify(bw) : av === bw;
  });
}

/** 学习步骤的内容指纹，用于判断回灌后是否又有新改动 */
export function stepSignature(step: LessonStep): string {
  return JSON.stringify(STEP_CONTENT_KEYS.map((key) => step[key]));
}

export function stepDiffFields(a: LessonStep, b: LessonStep): { key: keyof LessonStep; label: string }[] {
  const labels: Record<string, string> = {
    title: '标题', kind: '类型', duration: '时长', demoTitle: '示范片段', handshape: '手形说明',
    gestureZone: '动作区域', caption: '字幕', captionPosition: '字幕位置', camera: '镜头角度',
    commonMistakes: '常见错误', exercise: '练习任务', exerciseFeedback: '练习反馈',
    altText: '替代文本', prerequisiteId: '前置步骤', difficulty: '难度', cuePoints: '检查点',
  };
  return STEP_CONTENT_KEYS
    .filter((key) => {
      const av = a[key] as unknown;
      const bv = b[key] as unknown;
      return typeof av === 'object' || typeof bv === 'object'
        ? JSON.stringify(av) !== JSON.stringify(bv)
        : av !== bv;
    })
    .map((key) => ({ key, label: labels[key] ?? String(key) }));
}

/** 便于差异面板展示的字段值 */
export function formatStepField(step: LessonStep, key: keyof LessonStep): string {
  const value = step[key];
  if (Array.isArray(value)) return value.length ? value.join('、') : '（空）';
  if (key === 'prerequisiteId') {
    if (!value) return '无前置条件';
    return `步骤 ${String(value)}`;
  }
  if (value === '' || value === undefined || value === null) return '（空）';
  return String(value);
}

/* ---------------- 校验 ---------------- */

export function validateCourse(title: string, modules: CourseModule[]): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  if (!title.trim()) checks.push({ id: 'title', severity: 'error', title: '课程标题缺失', detail: '发布前需要为课程填写清晰标题。' });
  if (modules.length === 0) checks.push({ id: 'modules', severity: 'error', title: '没有课程模块', detail: '至少需要创建一个包含学习步骤的模块。' });

  modules.forEach((module) => {
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

export function cloneData<T>(value: T): T {
  return structuredClone(value);
}

/** 去掉个人副本的归属/状态字段，只留步骤内容，用于回灌 */
export function toLessonStep(step: PersonalStep): LessonStep {
  return {
    id: step.id,
    title: step.title,
    kind: step.kind,
    duration: step.duration,
    demoTitle: step.demoTitle,
    demoUrl: step.demoUrl,
    handshape: step.handshape,
    gestureZone: step.gestureZone,
    caption: step.caption,
    captionPosition: step.captionPosition,
    camera: step.camera,
    commonMistakes: cloneData(step.commonMistakes),
    exercise: step.exercise,
    exerciseFeedback: step.exerciseFeedback,
    altText: step.altText,
    prerequisiteId: step.prerequisiteId,
    difficulty: step.difficulty,
    cuePoints: cloneData(step.cuePoints),
  };
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
