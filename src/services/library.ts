import {
  cloneData,
  stepsContentEqual,
  uid,
  type BackfillItem,
  type BackfillRequest,
  type CourseModule,
  type CourseVersion,
  type LibraryCourse,
  type LessonStep,
  type PersonalModule,
  type PersonalStep,
  type TeacherCopy,
  type WorkspaceUser,
} from '../models';

export interface SyncReport {
  upgraded: string[];
  conflicts: string[];
  added: string[];
  removed: string[];
  pendingDeletions: string[];
  modulesAdded: string[];
  hasPendingWork: boolean;
}

function labelOf(moduleTitle: string, step: LessonStep): string {
  return `${moduleTitle} / ${step.title}`;
}

/** 从已发布版本取一份到老师名下，步骤全部标记为 clean */
export function pullCopy(course: LibraryCourse, user: WorkspaceUser, now: string): TeacherCopy {
  const version = course.versions.find((item) => item.version === course.publishedVersion) ?? course.versions[course.versions.length - 1];
  const modules: PersonalModule[] = version.modules.map((module) => ({
    id: module.id,
    sourceModuleId: module.id,
    title: module.title,
    summary: module.summary,
    color: module.color,
    state: 'clean',
    steps: module.steps.map((step) => ({ ...cloneData(step), sourceStepId: step.id, state: 'clean' as const })),
    droppedStepIds: [],
  }));
  return {
    id: uid('copy'),
    libraryCourseId: course.id,
    title: course.title,
    teacherId: user.id,
    teacherName: user.name,
    audience: course.audience,
    color: course.color,
    sourceVersion: version.version,
    modules,
    lastSavedAt: now,
    revision: 1,
    lastSyncNotice: `已从课程库取课（${version.label}）。`,
  };
}

/**
 * 三向合并：以取课时版本为基准，把老师名下副本升级到新版本。
 * - 老师没动、库里改了：直接升级；
 * - 老师动了、库里也改了：保留两边内容，标 conflict 等老师裁定；
 * - 库里删除：clean 步骤随升级移除，老师改过的保留并提示。
 */
export function mergeCopyWithVersion(
  copy: TeacherCopy,
  baseModules: CourseModule[],
  targetModules: CourseModule[],
  _targetVersion: number,
): { modules: PersonalModule[]; report: SyncReport } {
  const report: SyncReport = { upgraded: [], conflicts: [], added: [], removed: [], pendingDeletions: [], modulesAdded: [], hasPendingWork: false };
  const result: PersonalModule[] = [];

  targetModules.forEach((targetModule) => {
    const personalModule = copy.modules.find((item) => item.sourceModuleId === targetModule.id && !item.upstreamDeleted);
    const baseModule = baseModules.find((item) => item.id === targetModule.id);

    if (!personalModule) {
      result.push({
        id: targetModule.id,
        sourceModuleId: targetModule.id,
        title: targetModule.title,
        summary: targetModule.summary,
        color: targetModule.color,
        state: 'clean',
        steps: targetModule.steps.map((step) => ({ ...cloneData(step), sourceStepId: step.id, state: 'clean' as const })),
        droppedStepIds: [],
      });
      report.modulesAdded.push(targetModule.title);
      return;
    }

    const mergedSteps: PersonalStep[] = [];
    const consumedPersonalIds = new Set<string>();

    targetModule.steps.forEach((targetStep) => {
      const personalStep = personalModule.steps.find((step) => step.sourceStepId === targetStep.id);
      const baseStep = baseModule?.steps.find((step) => step.id === targetStep.id);
      if (!personalStep) {
        if (personalModule.droppedStepIds?.includes(targetStep.id)) return;
        mergedSteps.push({ ...cloneData(targetStep), sourceStepId: targetStep.id, state: 'clean' });
        report.added.push(labelOf(targetModule.title, targetStep));
        return;
      }
      consumedPersonalIds.add(personalStep.id);
      const upstreamChanged = !baseStep || !stepsContentEqual(baseStep, targetStep);
      const localChanged = personalStep.state !== 'clean';
      if (!upstreamChanged) {
        mergedSteps.push({ ...personalStep, upstreamDeleted: false });
        return;
      }
      if (!localChanged) {
        mergedSteps.push({ ...cloneData(targetStep), sourceStepId: targetStep.id, state: 'clean' });
        report.upgraded.push(labelOf(targetModule.title, targetStep));
        return;
      }
      // 老师内容与库目标已经一致（改动通过回灌进了库）：直接对齐，不算冲突
      if (stepsContentEqual(personalStep, targetStep)) {
        mergedSteps.push({ ...cloneData(targetStep), sourceStepId: targetStep.id, state: 'clean', backfilledSignature: undefined });
        report.upgraded.push(labelOf(targetModule.title, targetStep));
        return;
      }
      // 两边都改了：不替老师做主，把库版本摆进 upstreamStep
      mergedSteps.push({ ...personalStep, state: 'conflict', upstreamStep: cloneData(targetStep), upstreamDeleted: false });
      report.conflicts.push(labelOf(targetModule.title, targetStep));
    });

    // 库中已删除的步骤：clean 的随升级移除，老师动过的留下待裁定
    personalModule.steps.forEach((personalStep) => {
      if (consumedPersonalIds.has(personalStep.id)) return;
      if (!personalStep.sourceStepId) return; // 老师自建步骤，下面统一处理
      if (personalStep.state === 'clean') {
        const baseStep = baseModule?.steps.find((step) => step.id === personalStep.sourceStepId);
        if (baseStep && !targetModule.steps.some((step) => step.id === personalStep.sourceStepId)) {
          report.removed.push(labelOf(targetModule.title, personalStep));
          return;
        }
      }
      mergedSteps.push({ ...personalStep, upstreamDeleted: true });
      report.pendingDeletions.push(labelOf(targetModule.title, personalStep));
    });

    // 老师自建步骤：按副本里的相对位置插回
    personalModule.steps.forEach((personalStep) => {
      if (consumedPersonalIds.has(personalStep.id) || personalStep.sourceStepId || personalStep.upstreamDeleted) return;
      const personalIndex = personalModule.steps.indexOf(personalStep);
      let insertAt = mergedSteps.length;
      for (let i = personalIndex - 1; i >= 0; i -= 1) {
        const predecessor = personalModule.steps[i];
        const anchor = mergedSteps.findIndex((item) => item.id === predecessor.id);
        if (anchor >= 0) { insertAt = anchor + 1; break; }
      }
      mergedSteps.splice(insertAt, 0, personalStep);
    });

    const moduleMetaChanged = personalModule.state !== 'clean';
    const mergedModule: PersonalModule = {
      ...personalModule,
      title: moduleMetaChanged ? personalModule.title : targetModule.title,
      summary: moduleMetaChanged ? personalModule.summary : targetModule.summary,
      color: moduleMetaChanged ? personalModule.color : targetModule.color,
      steps: mergedSteps,
    };
    result.push(mergedModule);
  });

  // 库里整个模块被删除：clean 移除，老师动过的保留待裁定
  copy.modules.forEach((personalModule) => {
    if (!personalModule.sourceModuleId) { result.push(personalModule); return; }
    if (targetModules.some((module) => module.id === personalModule.sourceModuleId)) return;
    if (personalModule.state === 'clean' && !personalModule.steps.some((step) => step.state !== 'clean')) {
      report.removed.push(personalModule.title);
      return;
    }
    result.push({ ...personalModule, upstreamDeleted: true });
    report.pendingDeletions.push(personalModule.title);
  });

  report.hasPendingWork = report.conflicts.length > 0 || report.pendingDeletions.length > 0;
  return { modules: result, report };
}

/** 冲突裁定：采用库版本 */
export function resolveConflictTakeUpstream(step: PersonalStep): PersonalStep {
  if (!step.upstreamStep) return { ...step, state: 'modified' };
  return { ...cloneData(step.upstreamStep), sourceStepId: step.sourceStepId, state: 'clean', upstreamStep: undefined, upstreamDeleted: false };
}

/** 冲突裁定：保留老师自己的版本 */
export function resolveConflictKeepMine(step: PersonalStep): PersonalStep {
  return { ...step, state: 'modified', upstreamStep: undefined };
}

/* ---------------- 回灌 ---------------- */

export interface BackfillResult {
  modules: CourseModule[];
  items: BackfillItem[];
}

/**
 * 把一份回灌申请逐项补进课程库草稿。每项独立结算：
 * 结构问题（模块/锚点缺失）只失败该步骤，不影响其余步骤。
 * 返回每项的最新状态，调用方据此决定申请去留与重试。
 */
export function applyBackfill(draftModules: CourseModule[], request: BackfillRequest): BackfillResult {
  const modules = cloneData(draftModules);
  const items = cloneData(request.items);
  // 副本步骤 id → 库步骤 id（库来源步骤沿用原 id，自建步骤按插入顺序领新 id）
  const idMap = new Map<string, string>();
  modules.forEach((module) => module.steps.forEach((step) => idMap.set(step.id, step.id)));

  items.forEach((item) => {
    if (item.state === 'applied') return;
    const module = modules.find((candidate) => candidate.id === item.sourceModuleId);
    if (!module) {
      item.state = 'failed';
      item.message = `课程库中找不到模块「${item.moduleTitle}」，该步骤未回灌。`;
      return;
    }

    const incoming = cloneData(item.step);
    const prerequisiteMapped = incoming.prerequisiteId ? idMap.get(incoming.prerequisiteId) ?? '' : '';
    if (incoming.prerequisiteId && !prerequisiteMapped) incoming.prerequisiteId = '';

    const notes: string[] = [];
    if (item.step.prerequisiteId && !prerequisiteMapped) notes.push('前置步骤在库中无对应项，已清空依赖');

    if (item.sourceStepId) {
      const target = module.steps.find((step) => step.id === item.sourceStepId);
      if (!target) {
        item.state = 'failed';
        item.message = `库步骤 ${item.sourceStepId} 已不存在，无法覆盖更新。`;
        return;
      }
      const targetIndex = module.steps.indexOf(target);
      module.steps[targetIndex] = { ...incoming, id: target.id };
      idMap.set(item.step.id, target.id);
      item.assignedLibraryStepId = target.id;
      item.state = 'applied';
      item.message = notes.length ? notes.join('；') : '已覆盖库中对应步骤。';
      return;
    }

    // 老师自建步骤 → 作为新步骤插入
    const newId = uid('libstep');
    const newStep = { ...incoming, id: newId };
    let anchorIndex = -1;
    if (item.afterStepId) {
      const anchorId = idMap.get(item.afterStepId);
      anchorIndex = module.steps.findIndex((step) => step.id === anchorId);
    }
    if (item.afterStepId && anchorIndex < 0) notes.push('原相邻步骤在库中不存在，已排到模块末尾');
    if (anchorIndex >= 0) module.steps.splice(anchorIndex + 1, 0, newStep);
    else module.steps.push(newStep);
    idMap.set(item.step.id, newId);
    item.assignedLibraryStepId = newId;
    item.state = 'applied';
    item.message = notes.length ? notes.join('；') : '已作为新步骤加入课程库。';
  });

  return { modules, items };
}

export function publishedVersionOf(course: LibraryCourse): CourseVersion | undefined {
  return course.versions.find((item) => item.version === course.publishedVersion);
}

export function versionAt(course: LibraryCourse, version: number): CourseVersion | undefined {
  return course.versions.find((item) => item.version === version);
}

export function countCopyConflicts(copy: TeacherCopy): number {
  let count = 0;
  copy.modules.forEach((module) => {
    if (module.upstreamDeleted) count += 1;
    module.steps.forEach((step) => {
      if (step.state === 'conflict' || step.upstreamDeleted) count += 1;
    });
  });
  return count;
}
