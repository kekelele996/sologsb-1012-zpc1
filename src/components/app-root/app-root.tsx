import { Component, Host, State, h, Listen } from '@stencil/core';
import {
  formatStepField,
  stepDiffFields,
  validateCourse,
  type CameraAngle,
  type CaptionPosition,
  type CourseModule,
  type Difficulty,
  type GestureZone,
  type LessonStep,
  type LibraryCourse,
  type PersonalModule,
  type PersonalStep,
  type TeacherCopy,
  type ValidationCheck,
} from '../../models';
import { countCopyConflicts, publishedVersionOf } from '../../services/library';
import { StudioStore, type ActionResult } from '../../services/studio-store';

type PreviewSize = 'phone' | 'tablet';
type WorkspaceView = 'library' | 'mine' | 'backfills';
type StepLike = LessonStep | PersonalStep;

interface DocSelection {
  courseId: string;
  moduleId: string;
  stepId: string;
}

@Component({
  tag: 'app-root',
  styleUrl: 'app-root.css',
  scoped: true,
})
export class AppRoot {
  private store = new StudioStore();
  @State() tick = 0;
  @State() view: WorkspaceView = this.store.isLeader ? 'library' : 'mine';
  @State() previewSize: PreviewSize = 'phone';
  @State() playing = false;
  @State() playProgress = 0;
  @State() toast?: { color: string; message: string };
  @State() modal?: { kind: 'publish' | 'backfill' | 'backfill-detail' | 'library-detail'; courseId?: string; copyId?: string; requestId?: string };
  @State() draftNote = '';
  private selection: Partial<Record<string, DocSelection>> = {};
  private playTimer?: number;
  private unsubscribe?: () => void;

  componentWillLoad(): void {
    this.unsubscribe = this.store.subscribe(() => { this.tick += 1; });
    // 迁移后老师落到个人副本；组长落到课程库
    this.view = this.store.isLeader ? 'library' : 'mine';
  }

  disconnectedCallback(): void {
    if (this.playTimer) window.clearInterval(this.playTimer);
    this.unsubscribe?.();
  }

  @Listen('online', { target: 'window' })
  handleOnline(): void {
    this.store.setLibraryOnline(true);
    this.showToast('success', '课程库已恢复，挂起的回灌申请正按学习步骤逐项补上。');
  }

  @Listen('offline', { target: 'window' })
  handleOffline(): void {
    this.store.setLibraryOnline(false);
    this.showToast('warning', '课程库不可用：取课、发布和回灌暂停，个人课程仍可在本地继续编排。');
  }

  @Listen('keydown', { target: 'window' })
  handleKeyboard(event: KeyboardEvent): void {
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName);
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.showToast('success', '改动已实时保存在本地工作区。');
    }
    if (!editing && this.activeStep && (this.view === 'mine' || this.view === 'library') && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      this.moveStep(event.key === 'ArrowUp' ? -1 : 1);
    }
  }

  /* ---------------- 当前文档与选择 ---------------- */

  private get workspace() {
    return this.store.workspace;
  }

  private get user() {
    return this.store.currentUser;
  }

  private get isLeader() {
    return this.store.isLeader;
  }

  private get myCopies(): TeacherCopy[] {
    return this.workspace.copies.filter((copy) => copy.teacherId === this.user.id);
  }

  private get activeCourse(): LibraryCourse | undefined {
    const id = this.selection['library']?.courseId ?? this.workspace.library[0]?.id;
    return this.workspace.library.find((course) => course.id === id) ?? this.workspace.library[0];
  }

  private get activeCopy(): TeacherCopy | undefined {
    if (this.view === 'mine' || this.view === 'backfills') {
      const mine = this.myCopies;
      const selectedId = this.selection['mine']?.courseId;
      return mine.find((copy) => copy.id === selectedId) ?? mine[0];
    }
    // 组长查看回灌来源时只读
    const detailRequestId = this.modal?.requestId;
    const request = this.workspace.backfills.find((item) => item.id === detailRequestId);
    if (request) return this.workspace.copies.find((copy) => copy.id === request.copyId);
    return undefined;
  }

  private get editingCopy(): TeacherCopy | undefined {
    // 老师只在「我的课程」编辑自己的副本
    if (this.view !== 'mine' || this.isLeader) return undefined;
    return this.activeCopy;
  }

  private get activeModules(): CourseModule[] | PersonalModule[] {
    if (this.view === 'library') return this.activeCourse?.draftModules ?? [];
    return this.activeCopy?.modules ?? [];
  }

  private get activeModule(): (CourseModule & { upstreamDeleted?: boolean }) | undefined {
    const modules = this.activeModules;
    const key = this.view === 'library' ? 'library' : 'mine';
    const selected = this.selection[key]?.moduleId;
    return (modules.find((module) => module.id === selected) ?? modules[0]) as (CourseModule & { upstreamDeleted?: boolean }) | undefined;
  }

  private get activeStep(): StepLike | undefined {
    const module = this.activeModule;
    if (!module) return undefined;
    const key = this.view === 'library' ? 'library' : 'mine';
    const selected = this.selection[key]?.stepId;
    return (module.steps.find((step) => step.id === selected) ?? module.steps[0]) as StepLike | undefined;
  }

  private rememberSelection(courseId: string, moduleId: string, stepId?: string): void {
    const key = this.view === 'library' ? 'library' : 'mine';
    this.selection[key] = { courseId, moduleId, stepId: stepId ?? this.selection[key]?.stepId ?? '' };
  }

  private selectCourse(courseId: string): void {
    const key = this.view === 'library' ? 'library' : 'mine';
    this.selection[key] = { courseId, moduleId: '', stepId: '' };
    this.tick += 1;
  }

  private selectModule(moduleId: string): void {
    const module = this.activeModules.find((item) => item.id === moduleId);
    const key = this.view === 'library' ? 'library' : 'mine';
    const courseId = this.view === 'library' ? this.activeCourse?.id ?? '' : this.activeCopy?.id ?? '';
    this.selection[key] = { courseId, moduleId, stepId: module?.steps[0]?.id ?? '' };
    this.tick += 1;
  }

  private selectStep(stepId: string): void {
    const key = this.view === 'library' ? 'library' : 'mine';
    const current = this.selection[key];
    if (current) current.stepId = stepId;
    this.tick += 1;
  }

  private get checks(): ValidationCheck[] {
    if (this.view === 'library') return validateCourse(this.activeCourse?.title ?? '', this.activeCourse?.draftModules ?? []);
    const copy = this.activeCopy;
    return copy ? validateCourse(copy.title, copy.modules) : [];
  }

  private run(action: () => ActionResult | undefined, successTone: 'success' | 'danger' = 'success'): void {
    const result = action();
    if (!result) return;
    if (result.message) this.showToast(result.ok ? successTone : 'danger', result.message);
  }

  private showToast(color: string, message: string): void {
    this.toast = { color, message };
    window.setTimeout(() => {
      if (this.toast?.message === message) this.toast = undefined;
    }, 3_600);
  }

  /* ---------------- 库 / 个人 编辑动作 ---------------- */

  private patchStep(patch: Partial<LessonStep>): void {
    const module = this.activeModule;
    const step = this.activeStep;
    const copy = this.editingCopy;
    if (!module || !step) return;
    if (this.view === 'library') {
      this.run(() => this.store.mutateLibraryStep(this.activeCourse!.id, module.id, step.id, patch));
    } else if (copy) {
      this.run(() => this.store.updatePersonalStep(copy.id, module.id, step.id, patch));
    }
  }

  private patchModule(patch: Partial<CourseModule> | Partial<Pick<PersonalModule, 'title' | 'summary' | 'color'>>): void {
    const module = this.activeModule;
    const copy = this.editingCopy;
    if (!module) return;
    if (this.view === 'library') {
      this.run(() => this.store.mutateLibraryModule(this.activeCourse!.id, module.id, patch));
    } else if (copy) {
      this.run(() => this.store.updatePersonalModule(copy.id, module.id, patch));
    }
  }

  private addStep(kind: LessonStep['kind'] = '示范'): void {
    const course = this.activeCourse;
    const copy = this.editingCopy;
    const module = this.activeModule;
    if (this.view === 'library' && course && module) {
      this.run(() => this.store.mutateLibraryStep(course.id, module.id, null, null, kind));
      return;
    }
    if (copy && module) {
      const outcome = this.store.addPersonalStep(copy.id, module.id, kind);
      if (outcome.step) this.rememberSelection(copy.id, module.id, outcome.step.id);
      this.run(() => outcome.result);
    }
  }

  private addModule(): void {
    const course = this.activeCourse;
    const copy = this.editingCopy;
    if (this.view === 'library' && course) {
      this.run(() => this.store.mutateLibraryModule(course.id, null, {}));
      return;
    }
    if (copy) {
      const outcome = this.store.addPersonalModule(copy.id);
      if (outcome.module) this.rememberSelection(copy.id, outcome.module.id, '');
      this.run(() => outcome.result);
    }
  }

  private duplicateStep(): void {
    const module = this.activeModule;
    const step = this.activeStep;
    const copy = this.editingCopy;
    if (!module || !step) return;
    if (this.view === 'library') {
      // 库内复制：读旧值再新增
      const clone = { ...this.plain(step) } as LessonStep;
      clone.id = `libstep-${Date.now().toString(36)}`;
      clone.title = `${step.title}（副本）`;
      this.run(() => {
        const result = this.store.mutateLibraryStep(this.activeCourse!.id, module.id, null, null, step.kind);
        if (!result.ok) return result;
        const added = module.steps.at(-1);
        if (!added) return result;
        return this.store.mutateLibraryStep(this.activeCourse!.id, module.id, added.id, clone);
      });
      return;
    }
    if (copy) this.run(() => this.store.duplicatePersonalStep(copy.id, module.id, step.id));
  }

  private deleteStep(): void {
    const module = this.activeModule;
    const step = this.activeStep;
    const copy = this.editingCopy;
    if (!module || !step) return;
    if (this.view === 'library') {
      this.run(() => this.store.mutateLibraryStep(this.activeCourse!.id, module.id, step.id, null));
    } else if (copy) {
      this.run(() => this.store.deletePersonalStep(copy.id, module.id, step.id));
    }
  }

  private moveStep(direction: number): void {
    const module = this.activeModule;
    const step = this.activeStep;
    const copy = this.editingCopy;
    if (!module || !step) return;
    if (this.view === 'library') {
      // 库内移动：草稿模块直接改数组顺序（组长操作）
      const steps = [...module.steps];
      const index = steps.findIndex((item) => item.id === step.id);
      const next = Math.max(0, Math.min(steps.length - 1, index + direction));
      if (next === index) return;
      const [item] = steps.splice(index, 1);
      steps.splice(next, 0, item);
      this.run(() => this.store.mutateLibraryModule(this.activeCourse!.id, module.id, { steps }));
      return;
    }
    if (copy) this.run(() => this.store.movePersonalStep(copy.id, module.id, step.id, direction));
  }

  private deleteModule(): void {
    const module = this.activeModule;
    const copy = this.editingCopy;
    if (!module) return;
    if (this.view === 'library') this.run(() => this.store.mutateLibraryModule(this.activeCourse!.id, module.id, null));
    else if (copy) this.run(() => this.store.deletePersonalModule(copy.id, module.id));
  }

  private plain(step: StepLike): LessonStep {
    const { sourceStepId, state, upstreamStep, upstreamDeleted, ...content } = step as PersonalStep;
    void sourceStepId; void state; void upstreamStep; void upstreamDeleted;
    return content as unknown as LessonStep;
  }

  /** Stencil JSX 的类型定义不含原生 select 的 value 属性，用 ref 同步当前值 */
  private bindSelect(value: string) {
    return (element: HTMLSelectElement | undefined) => {
      if (element && element.value !== value) element.value = value;
    };
  }

  /* ---------------- 课程库动作 ---------------- */

  private createCourse(): void {
    const outcome = this.store.createLibraryCourse('未命名标准课程');
    if (!outcome.course) {
      this.showToast('danger', outcome.result.message);
      return;
    }
    this.selection['library'] = { courseId: outcome.course.id, moduleId: '', stepId: '' };
    this.tick += 1;
    this.showToast('success', outcome.result.message);
  }

  private pullCourse(courseId: string): void {
    const outcome = this.store.pullFromLibrary(courseId);
    if (outcome.result.ok && outcome.copy) {
      this.selection['mine'] = { courseId: outcome.copy.id, moduleId: outcome.copy.modules[0]?.id ?? '', stepId: outcome.copy.modules[0]?.steps[0]?.id ?? '' };
      this.view = 'mine';
    }
    if (outcome.result.message) this.showToast(outcome.result.ok ? 'success' : 'danger', outcome.result.message);
  }

  private openPublish(): void {
    this.draftNote = '';
    this.modal = { kind: 'publish', courseId: this.activeCourse?.id };
  }

  private confirmPublish(): void {
    const course = this.activeCourse;
    if (!course) return;
    const outcome = this.store.publishLibraryCourse(course.id, this.draftNote);
    if (outcome.result.ok) {
      const who = outcome.upgradedCopies.length ? `已通知：${outcome.upgradedCopies.join('、')} 的副本。` : '';
      this.showToast('success', `${outcome.result.message}${who}`);
      this.modal = undefined;
    } else {
      this.showToast('danger', outcome.result.message);
    }
  }

  private toggleLibraryOnline(): void {
    const next = !this.workspace.libraryOnline;
    this.store.setLibraryOnline(next);
    this.showToast(next ? 'success' : 'warning', next ? '课程库已恢复，挂起申请已开始逐项补录。' : '已模拟课程库故障：取课/发布/回灌暂停，个人课程继续可编辑。');
  }

  /* ---------------- 个人课程动作 ---------------- */

  private upgradeCopy(): void {
    const copy = this.activeCopy;
    if (!copy) return;
    this.run(() => this.store.upgradeCopy(copy.id));
  }

  private openBackfill(): void {
    this.draftNote = '';
    this.modal = { kind: 'backfill', copyId: this.activeCopy?.id };
  }

  private confirmBackfill(): void {
    const copy = this.activeCopy;
    if (!copy) return;
    this.modal = undefined;
    this.run(() => this.store.submitBackfill(copy.id, this.draftNote));
  }

  private resolveConflict(step: PersonalStep, choice: 'upstream' | 'mine'): void {
    const copy = this.activeCopy;
    const module = this.activeModule;
    if (!copy || !module) return;
    this.run(() => this.store.resolveStepConflict(copy.id, module.id, step.id, choice));
  }

  private resolveDeletedStep(step: PersonalStep, keep: boolean): void {
    const copy = this.activeCopy;
    const module = this.activeModule;
    if (!copy || !module) return;
    this.run(() => this.store.resolveDeletedStep(copy.id, module.id, step.id, keep));
  }

  private resolveDeletedModule(module: PersonalModule, keep: boolean): void {
    const copy = this.activeCopy;
    if (!copy) return;
    this.run(() => this.store.resolveDeletedModule(copy.id, module.id, keep));
  }

  /* ---------------- 播放 ---------------- */

  private togglePlay(): void {
    if (this.playTimer) {
      window.clearInterval(this.playTimer);
      this.playTimer = undefined;
      this.playing = false;
      return;
    }
    const duration = Math.max(10, this.activeStep?.duration ?? 40);
    this.playing = true;
    this.playTimer = window.setInterval(() => {
      this.playProgress += 0.25 / duration;
      if (this.playProgress >= 1) {
        this.playProgress = 0;
        this.playing = false;
        if (this.playTimer) window.clearInterval(this.playTimer);
        this.playTimer = undefined;
      }
    }, 250);
  }

  private formatDate(value?: string): string {
    if (!value) return '—';
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  /* ---------------- 渲染：顶栏 ---------------- */

  private renderHeader() {
    return (
      <ion-header class="studio-header">
        <ion-toolbar>
          <ion-buttons slot="start"><div class="logo-mark">手</div><div class="app-title"><strong>SignCourse Studio</strong><span>手语课程编排 · 共享课程库 / 个人课程</span></div></ion-buttons>
          <ion-buttons slot="end" class="header-actions">
            <button class={`connection-status ${this.workspace.libraryOnline ? '' : 'offline'}`} onClick={() => this.toggleLibraryOnline()}>
              <span />{this.workspace.libraryOnline ? '课程库在线（点击模拟故障）' : '课程库故障中（点击恢复）'}
            </button>
            <div class="role-switch">
              <span>身份</span>
              <select
                ref={this.bindSelect(this.user.id)}
                onChange={(event) => { this.store.switchUser((event.target as HTMLSelectElement).value); this.view = this.store.isLeader ? 'library' : 'mine'; this.tick += 1; }}
              >
                {this.workspace.users.map((member) => <option value={member.id}>{member.name} · {member.role === 'leader' ? '教研组长' : '老师'}</option>)}
              </select>
            </div>
          </ion-buttons>
        </ion-toolbar>
      </ion-header>
    );
  }

  private renderViewTabs() {
    const mineConflictCount = this.myCopies.reduce((sum, copy) => sum + countCopyConflicts(copy), 0);
    const failedCount = this.workspace.backfills
      .filter((request) => this.isLeader || request.teacherId === this.user.id)
      .filter((request) => request.status !== 'rejected' && request.items.some((item) => item.state === 'failed')).length;
    return (
      <nav class="view-tabs">
        <button class={this.view === 'library' ? 'active' : ''} onClick={() => { this.view = 'library'; this.tick += 1; }}>
          共享课程库 {this.isLeader && <em class="role-tag">组长维护</em>}
        </button>
        {!this.isLeader && (
          <button class={this.view === 'mine' ? 'active' : ''} onClick={() => { this.view = 'mine'; this.tick += 1; }}>
            我的课程
            {mineConflictCount > 0 && <span class="tab-badge danger">{mineConflictCount} 待裁定</span>}
          </button>
        )}
        <button class={this.view === 'backfills' ? 'active' : ''} onClick={() => { this.view = 'backfills'; this.tick += 1; }}>
          回灌申请
          {failedCount > 0 && <span class="tab-badge warning">{failedCount} 待补录</span>}
        </button>
      </nav>
    );
  }

  /* ---------------- 渲染：课程库 ---------------- */

  private renderLibrarySidebar() {
    const active = this.activeCourse;
    return (
      <aside class="course-panel">
        <div class="panel-heading">
          <div><span class="eyebrow">Shared Library</span><h2>共享课程库</h2></div>
          {this.isLeader && <button class="add-step-button" title="新建标准课程" onClick={() => this.createCourse()}>＋</button>}
        </div>
        <div class="doc-list">
          {this.workspace.library.map((course) => {
            const version = publishedVersionOf(course);
            return (
              <button class={`doc-card ${course.id === active?.id ? 'active' : ''}`} onClick={() => this.selectCourse(course.id)}>
                <span class="doc-color" style={{ background: course.color }} />
                <span class="doc-copy">
                  <strong>{course.title}</strong>
                  <small>
                    {course.status === 'published'
                      ? `已发布 ${version?.label ?? ''} · ${course.draftModules.reduce((sum, m) => sum + m.steps.length, 0)} 步`
                      : '维护中草稿 · 尚未发布'}
                  </small>
                </span>
                <ion-badge color={course.status === 'published' ? 'success' : 'medium'}>{course.status === 'published' ? '已发布' : '草稿'}</ion-badge>
              </button>
            );
          })}
        </div>
        {this.renderModuleTree()}
        {this.renderModuleEditor()}
        <div class="sidebar-note">
          {this.isLeader
            ? '你是教研组长：标准课程、模块与步骤由你维护并发布版本；老师名下的课程你只读、不能改。'
            : '课程库由教研组长维护。取一份到你名下后，只改自己的副本，不能越权改动库里的标准课程。'}
        </div>
      </aside>
    );
  }

  private renderLibraryRibbon() {
    const course = this.activeCourse;
    if (!course) return <div class="project-ribbon empty">课程库还是空的。</div>;
    const version = publishedVersionOf(course);
    const errors = validateCourse(course.title, course.draftModules).filter((check) => check.severity === 'error').length;
    return (
      <div class="project-ribbon library">
        <div class="project-heading">
          <ion-badge color={course.status === 'published' ? 'success' : 'medium'}>{course.status === 'published' ? `已发布 ${version?.label ?? ''}` : '维护中草稿'}</ion-badge>
          {this.isLeader ? (
            <input
              class="plain-title-input"
              value={course.title}
              onInput={(event) => this.run(() => this.store.updateLibraryDraft(course.id, { title: (event.target as HTMLInputElement).value }, course.draftModules))}
            />
          ) : <strong class="plain-title-readonly">{course.title}</strong>}
          <span>{course.audience || '未填写适用对象'}</span>
        </div>
        <div class="project-metrics">
          <div><strong>{course.draftModules.length}</strong><span>模块</span></div>
          <div><strong>{course.draftModules.reduce((sum, item) => sum + item.steps.length, 0)}</strong><span>草稿步骤</span></div>
          <div><strong>{course.versions.length}</strong><span>发布版本</span></div>
          <div class={errors ? 'has-errors' : ''}><strong>{errors}</strong><span>阻断问题</span></div>
        </div>
        <div class="workflow-actions">
          {!this.isLeader && (
            this.myCopies.some((copy) => copy.libraryCourseId === course.id)
              ? <ion-button fill="outline" class="studio-button" onClick={() => { this.view = 'mine'; this.tick += 1; }}>已取课 · 打开我的副本</ion-button>
              : <ion-button color="primary" class="studio-button" disabled={!course.versions.length || !this.workspace.libraryOnline} onClick={() => this.pullCourse(course.id)}>取一份到我名下</ion-button>
          )}
          {this.isLeader && (
            <ion-button color="success" class="studio-button" disabled={!this.workspace.libraryOnline} onClick={() => this.openPublish()}>发布新版本 v{course.publishedVersion + 1}</ion-button>
          )}
        </div>
      </div>
    );
  }

  private renderVersionHistory(course: LibraryCourse) {
    return (
      <div class="version-history">
        <h3>发布版本</h3>
        {course.versions.length === 0 && <p class="muted-small">尚未发布。发布后老师才能取课。</p>}
        {[...course.versions].reverse().map((version) => (
          <div class={`version-item ${version.version === course.publishedVersion ? 'current' : ''}`}>
            <strong>{version.label}</strong>
            <span>{this.formatDate(version.publishedAt)}</span>
            <p>{version.note}</p>
          </div>
        ))}
      </div>
    );
  }

  /* ---------------- 渲染：我的课程 ---------------- */

  private renderCopySidebar() {
    const copies = this.myCopies;
    const active = this.activeCopy;
    return (
      <aside class="course-panel">
        <div class="panel-heading"><div><span class="eyebrow">My Courses</span><h2>我的课程</h2></div></div>
        <div class="doc-list">
          {copies.length === 0 && <div class="sidebar-empty">还没有取课。到「共享课程库」选一门已发布课程，取一份到你名下。</div>}
          {copies.map((copy) => {
            const course = this.workspace.library.find((item) => item.id === copy.libraryCourseId);
            const latest = course ? publishedVersionOf(course) : undefined;
            const conflicts = countCopyConflicts(copy);
            const outdated = latest ? latest.version > copy.sourceVersion : false;
            return (
              <button class={`doc-card ${copy.id === active?.id ? 'active' : ''}`} onClick={() => this.selectCourse(copy.id)}>
                <span class="doc-color" style={{ background: copy.color }} />
                <span class="doc-copy">
                  <strong>{copy.title}</strong>
                  <small>来源 v{copy.sourceVersion}{outdated ? ` · 库已到 v${latest?.version}` : ' · 与库同步'}</small>
                </span>
                {conflicts > 0
                  ? <ion-badge color="danger">{conflicts} 待裁定</ion-badge>
                  : outdated ? <ion-badge color="warning">可升级</ion-badge> : <ion-badge color="success">同步</ion-badge>}
              </button>
            );
          })}
        </div>
        {this.renderModuleTree()}
        {this.renderModuleEditor()}
        <div class="sidebar-note">副本里每个步骤都标了状态：未改动的随库升级；你改过的步骤，库再发布时会把两版摆出来由你裁定，不会被悄悄替换。</div>
      </aside>
    );
  }

  private renderCopyRibbon() {
    const copy = this.activeCopy;
    if (!copy) return <div class="project-ribbon empty">先到共享课程库取一门课。</div>;
    const course = this.workspace.library.find((item) => item.id === copy.libraryCourseId);
    const latest = course ? publishedVersionOf(course) : undefined;
    const outdated = latest ? latest.version > copy.sourceVersion : false;
    const conflicts = countCopyConflicts(copy);
    const modifiedSteps = copy.modules.reduce((sum, module) => sum + module.steps.filter((step) => step.state === 'modified' || step.state === 'new').length, 0);
    return (
      <div class="project-ribbon mine">
        <div class="project-heading">
          <ion-badge color="tertiary">个人副本</ion-badge>
          <input class="plain-title-input" value={copy.title} onInput={(event) => this.run(() => this.store.updateCopyMeta(copy.id, { title: (event.target as HTMLInputElement).value }))} />
          <span>来源：{course?.title ?? '（库课程缺失）'} v{copy.sourceVersion} · {copy.teacherName}</span>
        </div>
        <div class="project-metrics">
          <div><strong>{copy.modules.length}</strong><span>模块</span></div>
          <div><strong>{modifiedSteps}</strong><span>我改过/新增</span></div>
          <div><strong>{conflicts}</strong><span>{conflicts ? '待裁定' : '无冲突'}</span></div>
        </div>
        <div class="workflow-actions">
          {(outdated || conflicts > 0) && (
            <ion-button fill="outline" color={conflicts ? 'danger' : 'warning'} class="studio-button" disabled={!this.workspace.libraryOnline} onClick={() => this.upgradeCopy()}>
              {conflicts ? `检查库更新（${conflicts} 待裁定）` : `升级到 v${latest?.version}`}
            </ion-button>
          )}
          <ion-button color="primary" class="studio-button" disabled={!this.workspace.libraryOnline || modifiedSteps === 0} onClick={() => this.openBackfill()}>申请回灌课程库</ion-button>
        </div>
      </div>
    );
  }

  /* ---------------- 渲染：模块/步骤树 ---------------- */

  private stepStateBadge(step: StepLike) {
    if (!('state' in step)) return null;
    const p = step as PersonalStep;
    if (p.upstreamDeleted) return <span class="state-badge deleted" title="课程库已删除该步骤">库已删</span>;
    if (p.state === 'conflict') return <span class="state-badge conflict" title="你和课程库都改了这一步">两版冲突</span>;
    if (p.state === 'modified') return <span class="state-badge modified" title="你改过，升级时不会被替换">我改过</span>;
    if (p.state === 'new') return <span class="state-badge new" title="你自建的步骤">自建</span>;
    return <span class="state-badge clean" title="未改动，随课程库升级">未改动</span>;
  }

  private renderModuleTree() {
    const modules = this.activeModules as (CourseModule | PersonalModule)[];
    const activeModule = this.activeModule;
    const readonly = this.view === 'library' ? !this.isLeader : !this.editingCopy;
    const canEdit = !readonly;
    return (
      <div class="module-tree-wrap">
        <div class="tree-heading">
          <span class="eyebrow">课程结构</span>
          {canEdit && (
            <div class="tree-actions">
              <button class="tiny ghost" title="新增步骤" onClick={() => this.addStep('示范')}>＋步骤</button>
              <button class="tiny ghost" title="新增模块" onClick={() => this.addModule()}>＋模块</button>
            </div>
          )}
        </div>
        <div class="module-list">
        {(modules as PersonalModule[]).map((item) => {
          const deletedModule = 'upstreamDeleted' in item && item.upstreamDeleted;
          return (
            <section class={`module-card ${item.id === activeModule?.id ? 'active' : ''} ${deletedModule ? 'module-deleted' : ''}`} key={item.id}>
              <button class="module-head" onClick={() => this.selectModule(item.id)}>
                <span class="module-color" style={{ background: item.color }} />
                <span>
                  <strong>{item.title}{deletedModule && <em class="deleted-tag">库中已删除</em>}</strong>
                  <small>{item.steps.length} 个学习步骤{('state' in item && item.state !== 'clean') ? ' · 我改过模块' : ''}</small>
                </span>
              </button>
              {item.id === activeModule?.id && (
                <div class="step-list">
                  {deletedModule && (
                    <div class="module-delete-callout">
                      <span>课程库已删除整个模块，你本地有改动：</span>
                      <div class="inline-actions">
                        <button class="tiny primary" onClick={() => this.resolveDeletedModule(item, true)}>保留为我的模块</button>
                        <button class="tiny danger" onClick={() => this.resolveDeletedModule(item, false)}>跟随删除</button>
                      </div>
                    </div>
                  )}
                  {item.steps.map((lesson, index) => (
                    <button class={`step-list-item ${lesson.id === this.activeStep?.id ? 'active' : ''} ${('state' in lesson && (lesson as PersonalStep).state === 'conflict') ? 'is-conflict' : ''}`} onClick={() => this.selectStep(lesson.id)}>
                      <span class="step-index">{String(index + 1).padStart(2, '0')}</span>
                      <span class="step-copy">
                        <strong>{lesson.title}{('upstreamDeleted' in lesson && lesson.upstreamDeleted) && <em class="deleted-tag">库已删</em>}</strong>
                        <small>{lesson.kind} · {lesson.duration}s · {lesson.difficulty}</small>
                      </span>
                      {this.stepStateBadge(lesson)}
                    </button>
                  ))}
                </div>
              )}
            </section>
          );
        })}
        {readonly && <p class="muted-small tree-readonly">{this.view === 'library' ? '只读：标准课程由教研组长维护。' : '只读视图。'}</p>}
        </div>
      </div>
    );
  }

  private renderModuleEditor() {
    const module = this.activeModule;
    if (!module || this.view === 'backfills') return null;
    const readonly = this.view === 'library' ? !this.isLeader : !this.editingCopy;
    return (
      <div class="module-editor">
        <input
          class="line-input"
          disabled={readonly}
          value={module.title}
          placeholder="模块标题"
          onInput={(event) => this.patchModule({ title: (event.target as HTMLInputElement).value })}
        />
        <textarea
          class="line-input area"
          disabled={readonly}
          rows={2}
          value={module.summary}
          placeholder="模块目标"
          onInput={(event) => this.patchModule({ summary: (event.target as HTMLTextAreaElement).value })}
        />
        {!readonly && <div class="module-tools"><button class="tiny danger" onClick={() => this.deleteModule()}>删除模块</button></div>}
      </div>
    );
  }

  /* ---------------- 渲染：步骤编辑器（含冲突对照） ---------------- */

  private renderConflictBanner(step: PersonalStep, moduleTitle: string) {
    if (step.upstreamDeleted) {
      return (
        <div class="conflict-banner deleted">
          <div><strong>课程库已删除这个步骤</strong><span>{moduleTitle} · 你本地对它有改动。删除不能悄悄生效，由你决定去留。</span></div>
          <div class="inline-actions">
            <button class="tiny primary" onClick={() => this.resolveDeletedStep(step, true)}>保留为我的步骤</button>
            <button class="tiny danger" onClick={() => this.resolveDeletedStep(step, false)}>跟随库删除</button>
          </div>
        </div>
      );
    }
    if (step.state === 'conflict' && step.upstreamStep) {
      const diff = stepDiffFields(step, step.upstreamStep);
      return (
        <div class="conflict-banner">
          <div>
            <strong>升级冲突 · 两版都动过「{step.title}」</strong>
            <span>差异字段：{diff.map((field) => field.label).join('、') || '内容'}。你的版本不会被自动替换，请逐字段看完两版后裁定。</span>
          </div>
          <div class="inline-actions">
            <button class="tiny primary" onClick={() => this.resolveConflict(step, 'upstream')}>采用库新版本</button>
            <button class="tiny ghost" onClick={() => this.resolveConflict(step, 'mine')}>保留我的版本</button>
          </div>
        </div>
      );
    }
    return null;
  }

  private renderStepFields(step: StepLike, disabled: boolean) {
    const module = this.activeModule;
    const steps = module?.steps ?? [];
    const index = steps.findIndex((item) => item.id === step.id);
    const prerequisites = steps.filter((candidate, i) => candidate.id !== step.id && i < index);
    return [
      <section class="form-card">
        <div class="section-title"><span>01</span><div><h2>基础设计</h2><p>标题、类型、难度和预计时长</p></div></div>
        <div class="form-grid two">
          <label class="field"><span>步骤标题</span><input disabled={disabled} value={step.title} onInput={(event) => this.patchStep({ title: (event.target as HTMLInputElement).value })} /></label>
          <label class="field"><span>步骤类型</span>
            <select ref={this.bindSelect(step.kind)} disabled={disabled} onChange={(event) => this.patchStep({ kind: (event.target as HTMLSelectElement).value as LessonStep['kind'] })}>
              {['示范', '讲解', '练习'].map((kind) => <option value={kind}>{kind}</option>)}
            </select>
          </label>
          <label class="field"><span>难度标签</span>
            <select ref={this.bindSelect(step.difficulty)} disabled={disabled} onChange={(event) => this.patchStep({ difficulty: (event.target as HTMLSelectElement).value as Difficulty })}>
              {(['入门', '进阶', '挑战'] as Difficulty[]).map((item) => <option value={item}>{item}</option>)}
            </select>
          </label>
          <label class="field"><span>预计时长（秒）</span><input disabled={disabled} type="number" min="10" max="600" value={String(step.duration)} onInput={(event) => this.patchStep({ duration: Number((event.target as HTMLInputElement).value) || 0 })} /></label>
        </div>
      </section>,

      <section class="form-card">
        <div class="section-title"><span>02</span><div><h2>示范片段与镜头</h2><p>素材标识、手形、镜头角度和动作区域</p></div></div>
        <div class="demo-row">
          <div class={`video-thumbnail zone-${step.gestureZone}`}>
            <span class="play-mark">▶</span>
            <strong>{step.kind}片段</strong>
            <small>{step.camera}</small>
          </div>
          <div class="demo-fields">
            <label class="field"><span>示范片段名称</span><input disabled={disabled} value={step.demoTitle} onInput={(event) => this.patchStep({ demoTitle: (event.target as HTMLInputElement).value })} /></label>
            <label class="field"><span>本地素材地址（可空）</span><input disabled={disabled} value={step.demoUrl} placeholder="例如 assets/hello.mp4" onInput={(event) => this.patchStep({ demoUrl: (event.target as HTMLInputElement).value })} /></label>
          </div>
        </div>
        <div class="form-grid two">
          <label class="field"><span>镜头角度</span>
            <select ref={this.bindSelect(step.camera)} disabled={disabled} onChange={(event) => this.patchStep({ camera: (event.target as HTMLSelectElement).value as CameraAngle })}>
              {(['正面', '左侧 45°', '右侧 45°', '俯拍手部', '全身远景'] as CameraAngle[]).map((item) => <option value={item}>{item}</option>)}
            </select>
          </label>
          <label class="field"><span>主要手形区域</span>
            <select ref={this.bindSelect(step.gestureZone)} disabled={disabled} onChange={(event) => this.patchStep({ gestureZone: (event.target as HTMLSelectElement).value as GestureZone })}>
              {(['左侧', '中央', '右侧'] as GestureZone[]).map((item) => <option value={item}>{item}</option>)}
            </select>
          </label>
        </div>
        <label class="field block"><span>手形说明</span><textarea disabled={disabled} rows={2} value={step.handshape} onInput={(event) => this.patchStep({ handshape: (event.target as HTMLTextAreaElement).value })} /></label>
      </section>,

      <section class="form-card">
        <div class="section-title"><span>03</span><div><h2>字幕与无障碍</h2><p>字幕位置、动作遮挡与替代文本</p></div></div>
        <div class="form-grid two">
          <label class="field"><span>字幕位置</span>
            <select ref={this.bindSelect(step.captionPosition)} disabled={disabled} onChange={(event) => this.patchStep({ captionPosition: (event.target as HTMLSelectElement).value as CaptionPosition })}>
              {(['下方安全区', '上移 15%', '角标提示', '画面中央'] as CaptionPosition[]).map((item) => <option value={item}>{item}</option>)}
            </select>
          </label>
          <label class="field"><span>替代文本状态</span><input class={step.altText ? '' : 'invalid'} disabled value={step.altText ? '已填写' : '缺失'} /></label>
        </div>
        <label class="field block"><span>步骤字幕</span><textarea disabled={disabled} rows={2} value={step.caption} onInput={(event) => this.patchStep({ caption: (event.target as HTMLTextAreaElement).value })} /></label>
        <label class="field block"><span>替代文本（描述动作与表情）</span><textarea disabled={disabled} rows={2} class={step.altText ? '' : 'invalid'} value={step.altText} onInput={(event) => this.patchStep({ altText: (event.target as HTMLTextAreaElement).value })} /></label>
      </section>,

      <section class="form-card">
        <div class="section-title"><span>04</span><div><h2>学习依赖与练习</h2><p>前置步骤、常见错误、练习任务与反馈</p></div></div>
        <div class="form-grid two">
          <label class="field"><span>前置条件</span>
            <select ref={this.bindSelect(step.prerequisiteId)} disabled={disabled} onChange={(event) => this.patchStep({ prerequisiteId: (event.target as HTMLSelectElement).value })}>
              <option value="">无前置条件</option>
              {prerequisites.map((item) => <option value={item.id}>{item.title}</option>)}
            </select>
          </label>
          <label class="field"><span>检查点（秒，逗号分隔）</span><input disabled={disabled} value={step.cuePoints.join(', ')} onInput={(event) => this.patchStep({ cuePoints: (event.target as HTMLInputElement).value.split(/[,，\s]+/).map(Number).filter((value) => Number.isFinite(value)) })} /></label>
        </div>
        <label class="field block"><span>常见错误（每行一条）</span><textarea disabled={disabled} rows={3} value={step.commonMistakes.join('\n')} onInput={(event) => this.patchStep({ commonMistakes: (event.target as HTMLTextAreaElement).value.split('\n').filter(Boolean) })} /></label>
        <div class="form-grid two">
          <label class="field block"><span>练习任务</span><textarea disabled={disabled} rows={2} value={step.exercise} onInput={(event) => this.patchStep({ exercise: (event.target as HTMLTextAreaElement).value })} /></label>
          <label class="field block"><span>练习反馈</span><textarea disabled={disabled} rows={2} value={step.exerciseFeedback} onInput={(event) => this.patchStep({ exerciseFeedback: (event.target as HTMLTextAreaElement).value })} /></label>
        </div>
      </section>,
    ];
  }

  private renderConflictDiff(step: PersonalStep) {
    const upstream = step.upstreamStep;
    if (!upstream) return null;
    const diff = stepDiffFields(step, upstream);
    const fields = diff.length ? diff : stepDiffFields(upstream, step);
    return (
      <section class="form-card diff-card">
        <div class="section-title"><span>⚖</span><div><h2>两版对照</h2><p>左：课程库新版本　右：你的版本（裁定前均可查看）</p></div></div>
        <div class="diff-grid">
          <div class="diff-col upstream"><h4>课程库 v新版</h4></div>
          <div class="diff-col mine"><h4>我的版本</h4></div>
        </div>
        {fields.map(({ key, label }) => (
          <div class="diff-row">
            <div class="diff-field-label">{label}</div>
            <div class="diff-grid">
              <pre class="diff-col upstream">{formatStepField(upstream, key)}</pre>
              <pre class="diff-col mine">{formatStepField(step, key)}</pre>
            </div>
          </div>
        ))}
      </section>
    );
  }

  private renderStepEditor() {
    const module = this.activeModule;
    const step = this.activeStep;
    if (this.view === 'backfills') return this.renderBackfillView();
    if (!module) {
      return (
        <div class="empty-editor">
          <div class="empty-glyph">手</div>
          <h2>{this.view === 'library' ? '课程库中还没有模块' : '先取一门课到自己名下'}</h2>
          <p>{this.view === 'library'
            ? (this.isLeader ? '新建模块与标准步骤，整理好后发布版本。' : '标准课程由教研组长维护。')
            : '从共享课程库取一份已发布课程，再在这里编排自己的学习步骤。'}</p>
          {this.isLeader && this.view === 'library' && <ion-button class="studio-button" onClick={() => this.addModule()}>新建模块</ion-button>}
          {!this.isLeader && this.view === 'library' && <ion-button class="studio-button" onClick={() => { this.view = 'library'; }}>去课程库看看</ion-button>}
        </div>
      );
    }
    if (!step) {
      return (
        <div class="empty-editor">
          <div class="empty-glyph">步</div>
          <h2>这个模块还没有学习步骤</h2>
          <p>添加示范、讲解或练习步骤，然后设置前置条件与难度。</p>
          {((this.view === 'library' && this.isLeader) || this.editingCopy) && <ion-button class="studio-button" onClick={() => this.addStep('示范')}>添加第一个步骤</ion-button>}
        </div>
      );
    }
    const personal = 'state' in step ? step as PersonalStep : undefined;
    const readonly = this.view === 'library' ? !this.isLeader : !this.editingCopy;
    const conflict = personal?.state === 'conflict';
    const fieldsDisabled = readonly || conflict || Boolean(personal?.upstreamDeleted);
    return (
      <div class="step-editor">
        <div class="editor-title-row">
          <div>
            <span class="eyebrow">学习步骤 {module.steps.findIndex((item) => item.id === step.id) + 1} / {module.title}</span>
            <h1>{step.title}</h1>
            <p>{this.view === 'mine' ? `修订号 ${this.activeCopy?.revision ?? 1} · 本地自动保存` : '标准课程草稿 · 发布后对所有老师生效'}</p>
          </div>
          {!readonly && (
            <div class="title-actions">
              <ion-button fill="clear" class="studio-button" onClick={() => this.moveStep(-1)} title="Alt + ↑">上移</ion-button>
              <ion-button fill="clear" class="studio-button" onClick={() => this.moveStep(1)} title="Alt + ↓">下移</ion-button>
              <ion-button fill="outline" class="studio-button" onClick={() => this.duplicateStep()}>复制</ion-button>
              <ion-button fill="outline" color="danger" class="studio-button" onClick={() => this.deleteStep()}>删除</ion-button>
            </div>
          )}
        </div>
        {personal && this.renderConflictBanner(personal, module.title)}
        {personal?.state === 'conflict' && personal.upstreamStep && this.renderConflictDiff(personal)}
        {this.renderStepFields(step, fieldsDisabled)}
      </div>
    );
  }

  /* ---------------- 渲染：预览 ---------------- */

  private renderPreview() {
    const step = this.view === 'backfills' ? undefined : this.activeStep;
    const progress = Math.round(this.playProgress * 100);
    return (
      <section class="preview-panel">
        <div class="preview-head">
          <div><span class="eyebrow">学习者预览</span><h2>设备与安全区检查</h2></div>
          <ion-segment value={this.previewSize} class="studio-segment" onIonChange={(event) => { this.previewSize = event.detail.value as PreviewSize; }}>
            <ion-segment-button value="phone">手机</ion-segment-button>
            <ion-segment-button value="tablet">平板</ion-segment-button>
          </ion-segment>
        </div>
        {step ? (
          <div class={`device-frame ${this.previewSize}`}>
            <div class="device-top"><span>{this.previewSize === 'phone' ? '9:16' : '4:3'}</span><span>{step.camera}</span></div>
            <div class={`preview-stage zone-${step.gestureZone} caption-${step.captionPosition.replace(/\s|%/g, '')} ${step.captionPosition === '画面中央' && step.gestureZone === '中央' ? 'overlap-warning' : ''}`}>
              <div class="stage-grid" />
              <div class="signer">
                <div class="head"><span class="face"><i /><i /></span></div>
                <div class="torso" />
                <div class="arm arm-left"><span class="hand" /></div>
                <div class="arm arm-right"><span class="hand" /></div>
              </div>
              <div class="gesture-marker" style={{ left: step.gestureZone === '左侧' ? '18%' : step.gestureZone === '右侧' ? '70%' : '43%' }} />
              <div class="caption-preview">{step.caption || '未填写字幕'}</div>
              {step.captionPosition === '角标提示' && <div class="corner-caption">{step.caption.slice(0, 18) || '角标提示'}</div>}
              <div class="safe-area"><span>字幕安全区</span></div>
            </div>
            <div class="player-controls">
              <button class="play-button" onClick={() => this.togglePlay()}>{this.playing ? 'Ⅱ' : '▶'}</button>
              <div class="player-timeline">
                <span style={{ width: `${progress}%` }} />
                {step.cuePoints.map((cue) => <i style={{ left: `${Math.min(100, (cue / Math.max(1, step.duration)) * 100)}%` }} title={`检查点 ${cue}s`} />)}
              </div>
              <span class="time-code">{String(Math.floor(this.playProgress * step.duration)).padStart(2, '0')} / {step.duration}s</span>
            </div>
            <div class="preview-meta">
              <div><strong>{step.kind}</strong><span>步骤类型</span></div>
              <div><strong>{step.difficulty}</strong><span>难度标签</span></div>
              <div><strong>{step.cuePoints.length}</strong><span>检查点</span></div>
            </div>
            <p class="preview-caption-text">{step.caption}</p>
          </div>
        ) : <div class="empty-preview">{this.view === 'backfills' ? '回灌队列视图不提供预览。' : '选择步骤后显示设备预览。'}</div>}
        {this.view === 'library' && this.activeCourse && this.renderVersionHistory(this.activeCourse)}
      </section>
    );
  }

  /* ---------------- 渲染：检查 / 回灌队列 ---------------- */

  private renderChecks() {
    const errors = this.checks.filter((check) => check.severity === 'error');
    const warnings = this.checks.filter((check) => check.severity === 'warning');
    const info = this.checks.filter((check) => check.severity === 'info');
    return (
      <section class="checks-panel">
        <div class="checks-summary">
          <div class="check-stat danger"><strong>{errors.length}</strong><span>阻断问题</span></div>
          <div class="check-stat warning"><strong>{warnings.length}</strong><span>需注意</span></div>
          <div class="check-stat"><strong>{info.length}</strong><span>优化建议</span></div>
        </div>
        <div class="check-list">
          {this.checks.length === 0 && <div class="all-clear"><strong>✓ 未发现问题</strong><p>字幕遮挡、步骤跳级和替代文本检查均已通过。</p></div>}
          {this.checks.map((check) => (
            <button class={`check-item ${check.severity}`} onClick={() => {
              if (check.moduleId) this.selectModule(check.moduleId);
              if (check.stepId) this.selectStep(check.stepId);
            }}>
              <span class="check-severity">{check.severity === 'error' ? '!' : check.severity === 'warning' ? '△' : 'i'}</span>
              <span><strong>{check.title}</strong><small>{check.detail}</small></span>
              <span class="check-arrow">→</span>
            </button>
          ))}
        </div>
      </section>
    );
  }

  @State() showChecks = false;

  private renderBackfillView() {
    const requests = this.isLeader
      ? this.workspace.backfills
      : this.workspace.backfills.filter((request) => request.teacherId === this.user.id);
    return (
      <div class="backfill-view">
        <div class="backfill-head">
          <div><span class="eyebrow">Backfill Queue</span><h2>回灌申请</h2><p>老师把改好的步骤申请补回课程库；失败的申请会留住，课程库恢复后按学习步骤逐项补上。</p></div>
        </div>
        {requests.length === 0 && <div class="all-clear"><strong>暂无回灌申请</strong><p>在「我的课程」里改好步骤后，可以整门课申请回灌。</p></div>}
        <div class="backfill-list">
          {requests.map((request) => {
            const applied = request.items.filter((item) => item.state === 'applied').length;
            const failed = request.items.filter((item) => item.state === 'failed').length;
            const queued = request.items.length - applied - failed;
            return (
              <article class={`backfill-card ${request.status === 'rejected' ? 'rejected' : ''} ${failed ? 'has-failed' : ''}`}>
                <header>
                  <div>
                    <strong>{request.courseTitle}</strong>
                    <span>{request.teacherName} · {this.formatDate(request.createdAt)}</span>
                    {request.note && <p class="note">留言：{request.note}</p>}
                  </div>
                  <div class="backfill-status">
                    {request.status === 'rejected' ? <ion-badge color="medium">已退回</ion-badge>
                      : failed ? <ion-badge color="danger">{failed} 项待补录</ion-badge>
                        : queued ? <ion-badge color="warning">{queued} 项排队中</ion-badge>
                          : <ion-badge color="success">{applied}/{request.items.length} 已补入草稿</ion-badge>}
                  </div>
                </header>
                <div class="backfill-items">
                  {request.items.map((item) => (
                    <div class={`backfill-item ${item.state}`}>
                      <span class="item-state-dot" />
                      <div class="item-copy">
                        <strong>{item.moduleTitle} / {item.step.title}</strong>
                        <small>{item.sourceStepId ? '更新库中对应步骤' : '作为新步骤加入'} · {item.state === 'applied' ? item.message : item.state === 'failed' ? `失败：${item.message}` : '等待课程库补录'}</small>
                      </div>
                      <b>{item.state === 'applied' ? '已补上' : item.state === 'failed' ? '失败留住' : '排队'}</b>
                    </div>
                  ))}
                </div>
                <footer>
                  {failed > 0 && !this.isLeader && <ion-button size="small" color="primary" class="studio-button" disabled={!this.workspace.libraryOnline} onClick={() => this.run(() => this.store.retryBackfill(request.id))}>立即逐项重试</ion-button>}
                  {failed > 0 && this.isLeader && <ion-button size="small" fill="outline" class="studio-button" disabled={!this.workspace.libraryOnline} onClick={() => this.run(() => this.store.retryBackfill(request.id))}>恢复后补录</ion-button>}
                  {this.isLeader && request.status !== 'rejected' && <ion-button size="small" fill="outline" color="medium" class="studio-button" onClick={() => this.run(() => this.store.rejectBackfill(request.id))}>退回申请</ion-button>}
                  <span class="muted-small">{request.status === 'pending' && !this.workspace.libraryOnline ? '课程库故障中：申请已留住，恢复后自动补。' : ''}</span>
                </footer>
              </article>
            );
          })}
        </div>
      </div>
    );
  }

  /* ---------------- 弹窗 ---------------- */

  private renderModal() {
    if (!this.modal) return null;
    if (this.modal.kind === 'publish') {
      const course = this.activeCourse;
      return (
        <div class="modal-backdrop" onClick={() => { this.modal = undefined; }}>
          <div class="modal-card" onClick={(event) => event.stopPropagation()}>
            <h3>发布课程库新版本 v{course ? course.publishedVersion + 1 : 1}</h3>
            <p>发布后，老师名下副本里<strong>没动过的步骤会立即跟着升级</strong>；两边都改过的步骤会进入两版对照，由老师自己裁定，不会被替换。</p>
            <textarea rows={3} placeholder="版本说明（改了哪些标准内容）" value={this.draftNote} onInput={(event) => { this.draftNote = (event.target as HTMLTextAreaElement).value; }} />
            <div class="modal-actions">
              <ion-button fill="clear" class="studio-button" onClick={() => { this.modal = undefined; }}>取消</ion-button>
              <ion-button color="success" class="studio-button" onClick={() => this.confirmPublish()}>确认发布</ion-button>
            </div>
          </div>
        </div>
      );
    }
    if (this.modal.kind === 'backfill') {
      const copy = this.activeCopy;
      const changed = copy ? copy.modules.flatMap((module) => module.steps.filter((step) => step.state === 'modified' || step.state === 'new').map((step) => `${module.title} / ${step.title}`)) : [];
      return (
        <div class="modal-backdrop" onClick={() => { this.modal = undefined; }}>
          <div class="modal-card" onClick={(event) => event.stopPropagation()}>
            <h3>申请回灌课程库</h3>
            <p>以下 {changed.length} 个步骤将按学习步骤逐项补入教研组长的标准课程草稿；若课程库暂时不可用，申请会留住，恢复后自动补。</p>
            <ul class="modal-item-list">{changed.map((label) => <li>{label}</li>)}</ul>
            <textarea rows={2} placeholder="给教研组长的留言（可空）" value={this.draftNote} onInput={(event) => { this.draftNote = (event.target as HTMLTextAreaElement).value; }} />
            <div class="modal-actions">
              <ion-button fill="clear" class="studio-button" onClick={() => { this.modal = undefined; }}>取消</ion-button>
              <ion-button color="primary" class="studio-button" onClick={() => this.confirmBackfill()}>提交申请</ion-button>
            </div>
          </div>
        </div>
      );
    }
    return null;
  }

  /* ---------------- 主渲染 ---------------- */

  render() {
    void this.tick;
    const copy = this.view === 'mine' ? this.activeCopy : undefined;
    const errors = this.checks.filter((check) => check.severity === 'error').length;
    const editorContent = this.view === 'backfills' ? this.renderBackfillView()
      : this.showChecks ? this.renderChecks()
        : this.renderStepEditor();
    return (
      <Host>
        <ion-app>
          {this.renderHeader()}
          {this.renderViewTabs()}
          <ion-content fullscreen class="studio-content">
            {this.view === 'library' && this.renderLibraryRibbon()}
            {this.view === 'mine' && this.renderCopyRibbon()}

            <main class="studio-workspace">
              {this.view === 'library' ? this.renderLibrarySidebar()
                : this.view === 'mine' ? this.renderCopySidebar()
                  : <aside class="course-panel"><div class="panel-heading"><div><span class="eyebrow">Queue</span><h2>回灌队列</h2></div></div><div class="sidebar-note">失败不丢申请：课程库恢复后按步骤逐项补录，每项独立结算。</div></aside>}

              <section class="editor-panel">
                {this.view !== 'backfills' && (
                  <div class="panel-switcher">
                    <button class={!this.showChecks ? 'active' : ''} onClick={() => { this.showChecks = false; }}>步骤编排</button>
                    <button class={this.showChecks ? 'active' : ''} onClick={() => { this.showChecks = true; }}>发布前检查 <span>{this.checks.length}</span>{errors > 0 && <em class="check-dot">{errors}</em>}</button>
                    {this.view === 'library' && this.isLeader && <span class="panel-hint">标准草稿 · 发布后老师才能取到</span>}
                    {this.view === 'mine' && copy && <span class="panel-hint">来源 v{copy.sourceVersion} · {countCopyConflicts(copy) ? `${countCopyConflicts(copy)} 项待裁定` : '全部同步'}</span>}
                  </div>
                )}
                <div class={`editor-scroll ${this.view === 'backfills' ? 'flush' : ''}`}>{editorContent}</div>
              </section>

              {this.renderPreview()}
            </main>
          </ion-content>
          {this.renderModal()}
          <ion-toast isOpen={Boolean(this.toast)} message={this.toast?.message} color={this.toast?.color} duration={3600} onDidDismiss={() => { this.toast = undefined; }} />
        </ion-app>
      </Host>
    );
  }
}
