import { Component, Host, State, Listen, h } from '@stencil/core';
import { WorkspaceStore, type ActionResult } from '../../store';
import {
  type CameraAngle,
  type CaptionPosition,
  type CourseVersion,
  type Difficulty,
  type GestureZone,
  type Identity,
  type LessonStep,
  type LibraryCourse,
  type LibraryModule,
  type LibraryStep,
  type PersonalCourse,
  type PersonalModule,
  type PersonalStep,
  type ValidationCheck,
} from '../../models';

type PreviewSize = 'phone' | 'tablet';
type View = 'library' | 'mine' | 'requests';
type CenterPanel = 'editor' | 'conflicts' | 'checks';

interface Toast { color: string; message: string }

const STEP_STATE_LABEL: Record<PersonalStep['state'], string> = {
  clean: '未改动',
  dirty: '已自改',
  local: '个人自建',
  resolved: '已定夺',
};

@Component({
  tag: 'app-root',
  styleUrl: 'app-root.css',
  scoped: true,
})
export class AppRoot {
  private store!: WorkspaceStore;
  @State() private rev = 0;
  @State() private view: View = 'mine';
  @State() private centerPanel: CenterPanel = 'editor';
  @State() private previewSize: PreviewSize = 'phone';
  @State() private selectedLibraryCourseId = '';
  @State() private selectedPersonalCourseId = '';
  @State() private selectedLibModuleId = '';
  @State() private selectedLibStepId = '';
  @State() private selectedPersonalModuleId = '';
  @State() private selectedPersonalStepId = '';
  @State() private toast?: Toast;
  @State() private playing = false;
  @State() private playProgress = 0;
  @State() private showPublishModal = false;
  @State() private publishNote = '';
  @State() private showBackfillModal = false;
  @State() private backfillNote = '';
  @State() private backfillSelected: Record<string, boolean> = {};
  @State() private showIdentityMenu = false;
  private playTimer?: number;
  private past: string[] = [];
  private future: string[] = [];

  componentWillLoad(): void {
    this.store = new WorkspaceStore();
    this.selectedLibraryCourseId = this.store.libraryCourses[0]?.id ?? '';
    const mine = this.store.personalCourses[0];
    if (mine) {
      this.selectedPersonalCourseId = mine.id;
      this.view = 'mine';
      this.syncPersonalSelection(mine);
    } else {
      this.view = 'library';
    }
  }

  disconnectedCallback(): void {
    if (this.playTimer) window.clearInterval(this.playTimer);
  }

  private bump(): void {
    this.rev += 1;
  }

  /** 所有写操作的入口：负责历史栈、提示与刷新。 */
  private run(action: () => ActionResult | undefined): void {
    const before = JSON.stringify(this.store.workspace);
    const result = action();
    if (result && !result.ok) {
      this.showToast('danger', result.message);
      return;
    }
    const after = JSON.stringify(this.store.workspace);
    if (before !== after) {
      this.past = [...this.past, before].slice(-60);
      this.future = [];
    }
    this.bump();
    if (result?.ok) this.showToast('success', result.message);
  }

  @Listen('keydown', { target: 'window' })
  handleKeyboard(event: KeyboardEvent): void {
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName);
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
    }
    if (!editing && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && this.view === 'mine') {
      const course = this.personalCourse;
      const step = this.personalStep;
      if (course && step) {
        this.run(() => this.store.movePersonalStep(course.id, this.selectedPersonalModuleId, step.id, event.key === 'ArrowUp' ? -1 : 1));
      }
    }
  }

  // ── 派生数据 ────────────────────────────────────────────────

  private get identity(): Identity {
    void this.rev;
    return this.store.identity;
  }

  private get isLeader(): boolean {
    return this.identity.role === 'leader';
  }

  private get libraryCourse(): LibraryCourse | undefined {
    void this.rev;
    return this.store.getLibraryCourse(this.selectedLibraryCourseId) ?? this.store.libraryCourses[0];
  }

  private get libModule(): LibraryModule | undefined {
    const course = this.libraryCourse;
    return course?.modules.find((module) => module.id === this.selectedLibModuleId) ?? course?.modules[0];
  }

  private get libStep(): LibraryStep | undefined {
    const module = this.libModule;
    return module?.steps.find((step) => step.id === this.selectedLibStepId) ?? module?.steps[0];
  }

  private get personalCourse(): PersonalCourse | undefined {
    void this.rev;
    return this.store.getPersonalCourse(this.selectedPersonalCourseId) ?? this.store.personalCourses[0];
  }

  private get personalModule(): PersonalModule | undefined {
    const course = this.personalCourse;
    return course?.modules.find((module) => module.id === this.selectedPersonalModuleId) ?? course?.modules[0];
  }

  private get personalStep(): PersonalStep | undefined {
    const module = this.personalModule;
    return module?.steps.find((step) => step.id === this.selectedPersonalStepId) ?? module?.steps[0];
  }

  private get activeStep(): LessonStep | undefined {
    return this.view === 'mine' ? this.personalStep : this.libStep;
  }

  private get libChecks(): ValidationCheck[] {
    return this.libraryCourse ? this.store.validateLibraryCourse(this.libraryCourse.id) : [];
  }

  private get personalChecks(): ValidationCheck[] {
    return this.personalCourse ? this.store.validatePersonalCourse(this.personalCourse.id) : [];
  }

  private get openConflicts() {
    return this.personalCourse?.conflicts.filter((item) => !item.choice) ?? [];
  }

  // ── 通用动作 ────────────────────────────────────────────────

  private showToast(color: string, message: string): void {
    this.toast = { color, message };
    window.setTimeout(() => {
      if (this.toast?.message === message) this.toast = undefined;
    }, 3_600);
  }

  private undo(): void {
    const snapshot = this.past.pop();
    if (!snapshot) return this.showToast('medium', '没有可撤销的修改。');
    this.future = [JSON.stringify(this.store.workspace), ...this.future].slice(0, 60);
    this.store.workspace = JSON.parse(snapshot);
    this.store.persist();
    this.bump();
  }

  private redo(): void {
    const snapshot = this.future.shift();
    if (!snapshot) return;
    this.past = [...this.past, JSON.stringify(this.store.workspace)].slice(-60);
    this.store.workspace = JSON.parse(snapshot);
    this.store.persist();
    this.bump();
  }

  private switchIdentity(id: string): void {
    this.run(() => {
      this.store.switchIdentity(id);
      this.view = this.store.isLeader ? 'library' : 'mine';
      const mine = this.store.personalCourses[0];
      if (mine) {
        this.selectedPersonalCourseId = mine.id;
        this.syncPersonalSelection(mine);
      }
      this.centerPanel = 'editor';
      return undefined;
    });
    this.showIdentityMenu = false;
  }

  private toggleLibraryConnection(): void {
    const next = !this.store.workspace.libraryOnline;
    this.run(() => {
      this.store.setLibraryOnline(next);
      return next
        ? { ok: true, message: '课程库连接已恢复。' }
        : { ok: true, message: '已模拟课程库中断：老师仍可编辑个人课程并发起回灌，申请会先留存。' };
    });
    if (next) {
      const result = this.store.retryPendingBackfills();
      if (result.message !== '当前没有待补的回灌申请。') this.showToast(result.ok ? 'success' : 'warning', result.message);
    }
  }

  private resetDemo(): void {
    this.run(() => {
      this.store.reset();
      this.selectedLibraryCourseId = this.store.libraryCourses[0]?.id ?? '';
      const mine = this.store.personalCourses[0];
      this.selectedPersonalCourseId = mine?.id ?? '';
      if (mine) this.syncPersonalSelection(mine);
      this.view = 'mine';
      return { ok: true, message: '已重置为首次迁移后的演示状态。' };
    });
  }

  private syncPersonalSelection(course: PersonalCourse): void {
    this.selectedPersonalModuleId = course.modules[0]?.id ?? '';
    this.selectedPersonalStepId = course.modules[0]?.steps[0]?.id ?? '';
  }

  private selectLibraryCourse(id: string): void {
    this.selectedLibraryCourseId = id;
    const course = this.store.getLibraryCourse(id);
    this.selectedLibModuleId = course?.modules[0]?.id ?? '';
    this.selectedLibStepId = course?.modules[0]?.steps[0]?.id ?? '';
    this.bump();
  }

  private selectPersonalCourse(id: string): void {
    this.selectedPersonalCourseId = id;
    const course = this.store.getPersonalCourse(id);
    if (course) this.syncPersonalSelection(course);
    this.centerPanel = this.openConflicts.length ? 'conflicts' : 'editor';
    this.bump();
  }

  // ── 课程库动作 ──────────────────────────────────────────────

  private patchLibraryStep(patch: Partial<LessonStep>): void {
    const course = this.libraryCourse;
    const module = this.libModule;
    const step = this.libStep;
    if (!course || !module || !step) return;
    this.run(() => this.store.updateLibraryStep(course.id, module.id, step.id, patch));
  }

  private patchLibraryMeta(patch: Partial<Pick<LibraryCourse, 'title' | 'summary' | 'audience'>>): void {
    const course = this.libraryCourse;
    if (!course) return;
    this.run(() => this.store.updateLibraryCourseMeta(course.id, patch));
  }

  private checkout(): void {
    const course = this.libraryCourse;
    if (!course) return;
    this.run(() => this.store.checkoutFromLibrary(course.id));
    const mine = this.store.personalCourses.find((item) => item.libraryCourseId === course.id);
    if (mine) {
      this.selectedPersonalCourseId = mine.id;
      this.syncPersonalSelection(mine);
      this.view = 'mine';
    }
  }

  private openPublish(): void {
    const blocking = this.libChecks.filter((check) => check.severity === 'error').length;
    if (blocking) {
      this.centerPanel = 'checks';
      this.showToast('danger', `发布被 ${blocking} 个阻断问题拦下，请先在"发布前检查"里修复。`);
      return;
    }
    this.publishNote = '';
    this.showPublishModal = true;
  }

  private confirmPublish(): void {
    const course = this.libraryCourse;
    if (!course) return;
    this.showPublishModal = false;
    this.run(() => this.store.publishLibraryCourse(course.id, this.publishNote));
  }

  // ── 个人课程动作 ────────────────────────────────────────────

  private patchPersonalStep(patch: Partial<LessonStep>): void {
    const course = this.personalCourse;
    const module = this.personalModule;
    const step = this.personalStep;
    if (!course || !module || !step) return;
    this.run(() => this.store.updatePersonalStep(course.id, module.id, step.id, patch));
  }

  private patchPersonalMeta(patch: Partial<Pick<PersonalCourse, 'title' | 'audience'>>): void {
    const course = this.personalCourse;
    if (!course) return;
    this.run(() => this.store.updatePersonalCourseMeta(course.id, patch));
  }

  private createPersonal(): void {
    this.run(() => this.store.createPersonalCourse());
    const course = this.store.personalCourses.at(-1);
    if (course) this.selectPersonalCourse(course.id);
  }

  private pullUpdates(): void {
    const course = this.personalCourse;
    if (!course) return;
    this.run(() => this.store.pullLibraryUpdates(course.id));
    if (this.openConflicts.length) this.centerPanel = 'conflicts';
  }

  private resolveConflict(stepId: string, choice: 'mine' | 'library'): void {
    const course = this.personalCourse;
    const conflict = course?.conflicts.find((item) => item.stepId === stepId && !item.choice);
    if (!course || !conflict) return;
    this.run(() => this.store.resolveConflict(course.id, conflict.moduleId, stepId, choice));
  }

  private addPersonalStep(kind: LessonStep['kind']): void {
    const course = this.personalCourse;
    const module = this.personalModule;
    if (!course) return;
    if (!module) {
      this.run(() => this.store.addPersonalModule(course.id));
      return;
    }
    this.run(() => this.store.addPersonalStep(course.id, module.id, kind));
    this.selectedPersonalModuleId = module.id;
    this.selectedPersonalStepId = module.steps.at(-1)?.id ?? '';
  }

  private addPersonalModule(): void {
    const course = this.personalCourse;
    if (!course) return;
    this.run(() => this.store.addPersonalModule(course.id));
    const module = course.modules.at(-1);
    if (module) {
      this.selectedPersonalModuleId = module.id;
      this.selectedPersonalStepId = '';
    }
  }

  private deletePersonalStep(): void {
    const course = this.personalCourse;
    const step = this.personalStep;
    if (!course || !step) return;
    this.run(() => this.store.deletePersonalStep(course.id, this.selectedPersonalModuleId, step.id));
  }

  private openBackfill(): void {
    const course = this.personalCourse;
    if (!course?.libraryCourseId) {
      this.showToast('warning', '个人从零创建的课程没有对应课程库，不能回灌。');
      return;
    }
    const eligible = course.modules.flatMap((module) =>
      module.steps.filter((step) => step.state !== 'local' && step.state !== 'clean'),
    );
    if (!eligible.length) {
      this.showToast('medium', '还没有改过的标准步骤；先在个人课程里调整学习步骤后再申请回灌。');
      return;
    }
    const selected: Record<string, boolean> = {};
    eligible.forEach((step) => { selected[step.id] = true; });
    this.backfillSelected = selected;
    this.backfillNote = '';
    this.showBackfillModal = true;
  }

  private toggleBackfillPick(stepId: string): void {
    this.backfillSelected = { ...this.backfillSelected, [stepId]: !this.backfillSelected[stepId] };
  }

  private submitBackfill(): void {
    const course = this.personalCourse;
    if (!course) return;
    const ids = Object.keys(this.backfillSelected).filter((id) => this.backfillSelected[id]);
    this.showBackfillModal = false;
    this.run(() => this.store.requestBackfill(course.id, this.backfillNote, ids));
  }

  private retryBackfills(): void {
    this.run(() => this.store.retryPendingBackfills());
  }

  // ── 播放 ────────────────────────────────────────────────────

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

  private formatDate(value: string): string {
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  // ── 渲染：头部与导航 ────────────────────────────────────────

  private renderHeader() {
    const online = this.store.workspace.libraryOnline;
    return (
      <ion-header class="studio-header">
        <ion-toolbar>
          <ion-buttons slot="start">
            <div class="logo-mark">手</div>
            <div class="app-title"><strong>SignCourse Studio</strong><span>共享课程库 · 个人课程工作台</span></div>
          </ion-buttons>
          <ion-buttons slot="end" class="header-actions">
            <button class={`connection-status ${online ? '' : 'offline'}`} onClick={() => this.toggleLibraryConnection()}>
              <span />{online ? '课程库在线（点击模拟中断）' : '课程库中断（点击恢复并重试回灌）'}
            </button>
            <div class="identity-wrap">
              <button class="identity-button" onClick={() => { this.showIdentityMenu = !this.showIdentityMenu; }}>
                <span class="identity-avatar">{this.identity.name.slice(0, 1)}</span>
                <span><strong>{this.identity.name}</strong><small>{this.isLeader ? '教研组长' : '任课老师'} · 切换身份 ▾</small></span>
              </button>
              {this.showIdentityMenu && (
                <div class="identity-menu">
                  {this.store.workspace.identities.map((item) => (
                    <button class={item.id === this.identity.id ? 'active' : ''} onClick={() => this.switchIdentity(item.id)}>
                      <strong>{item.name}</strong><small>{item.title}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <ion-button fill="clear" class="studio-button" disabled={this.past.length === 0} onClick={() => this.undo()}>撤销</ion-button>
            <ion-button fill="clear" class="studio-button" disabled={this.future.length === 0} onClick={() => this.redo()}>重做</ion-button>
            <ion-button fill="clear" class="studio-button" onClick={() => this.resetDemo()}>重置演示</ion-button>
          </ion-buttons>
        </ion-toolbar>
      </ion-header>
    );
  }

  private renderSubNav() {
    const items: { key: View; label: string; badge?: number }[] = this.isLeader
      ? [
          { key: 'library', label: '共享课程库' },
          { key: 'requests', label: '回灌审核', badge: this.pendingReviewCount() || undefined },
        ]
      : [
          { key: 'mine', label: '我的课程', badge: this.totalOpenConflicts() || undefined },
          { key: 'library', label: '共享课程库（取用）' },
          { key: 'requests', label: '我的回灌申请', badge: this.pendingRequestCount() || undefined },
        ];
    return (
      <nav class="sub-nav">
        {items.map((item) => (
          <button class={this.view === item.key ? 'active' : ''} onClick={() => { this.view = item.key; this.bump(); }}>
            {item.label}
            {item.badge ? <span class="nav-badge">{item.badge}</span> : null}
          </button>
        ))}
      </nav>
    );
  }

  private totalOpenConflicts(): number {
    return this.store.personalCourses.reduce((sum, course) => sum + course.conflicts.filter((item) => !item.choice).length, 0);
  }

  /** 组长待审核：已补入工作稿、且尚未包含在任何已发布版本中的条目。 */
  private pendingReviewCount(): number {
    return this.store.requests.reduce((sum, request) => sum + request.items.filter((item) => {
      if (item.status !== 'applied') return false;
      const course = this.store.getLibraryCourse(item.libraryCourseId);
      return Boolean(course && (item.appliedVersion ?? 0) > course.currentVersion);
    }).length, 0);
  }

  private pendingRequestCount(): number {
    return this.store.requests
      .filter((request) => request.teacherId === this.identity.id)
      .reduce((sum, request) => sum + request.items.filter((item) => item.status === 'pending' || item.status === 'failed').length, 0);
  }

  // ── 渲染：课程库 ────────────────────────────────────────────

  private renderLibraryView() {
    const course = this.libraryCourse;
    if (!course) return <div class="empty-page">课程库中还没有课程。</div>;
    const readOnly = !this.isLeader;
    const module = this.libModule;
    const step = this.libStep;
    return (
      <div class="workspace">
        <aside class="left-panel">
          <div class="panel-head">
            <div><span class="eyebrow">共享课程库</span><h2>{readOnly ? '浏览标准课程' : '维护标准课程'}</h2></div>
            {!readOnly && <button class="small-add" onClick={() => this.run(() => this.store.addLibraryModule(course.id))}>＋模块</button>}
          </div>
          <div class="course-list">
            {this.store.libraryCourses.map((item) => (
              <button class={`course-card ${item.id === course.id ? 'active' : ''}`} onClick={() => this.selectLibraryCourse(item.id)}>
                <div class="course-card-row">
                  <span class={`status-dot ${item.status}`} />
                  <strong>{item.title}</strong>
                </div>
                <small>v{item.currentVersion} · {item.modules.reduce((n, m) => n + m.steps.length, 0)} 个标准步骤 · {item.status === 'published' ? '已发布' : '工作稿'}</small>
              </button>
            ))}
          </div>
          <div class="module-list">
            {course.modules.map((item) => (
              <section class={`module-card ${item.id === module?.id ? 'active' : ''}`}>
                <button class="module-head" onClick={() => { this.selectedLibModuleId = item.id; this.selectedLibStepId = item.steps[0]?.id ?? ''; this.bump(); }}>
                  <span class="module-color" style={{ background: item.color }} />
                  <span><strong>{item.title}</strong><small>{item.steps.length} 个学习步骤</small></span>
                </button>
                {item.id === module?.id && (
                  <div class="step-list">
                    {item.steps.map((lesson) => (
                      <button class={`step-list-item ${lesson.id === step?.id ? 'active' : ''}`} onClick={() => { this.selectedLibStepId = lesson.id; this.bump(); }}>
                        <span class="step-copy"><strong>{lesson.title}</strong><small>{lesson.kind} · v{lesson.version}</small></span>
                      </button>
                    ))}
                    {!readOnly && (
                      <button class="inline-add" onClick={() => this.run(() => this.store.addLibraryStep(course.id, item.id, '示范'))}>＋ 标准步骤</button>
                    )}
                  </div>
                )}
              </section>
            ))}
          </div>
          {readOnly ? (
            <div class="panel-footer locked">
              <span class="lock-glyph">🔒</span>
              <div><strong>只读</strong><p>共享课程库由教研组长统一维护发布，老师不能越权修改；取用到个人课程后即可自由编排。</p></div>
              <ion-button class="studio-button" onClick={() => this.checkout()}>取用到我的课程</ion-button>
            </div>
          ) : (
            <div class="panel-footer">
              <ion-button class="studio-button" onClick={() => this.openPublish()}>发布新版本 v{course.currentVersion + 1}</ion-button>
              <p>发布后：老师名下未改动的步骤自动升级，改过的步骤转成两版对照由老师定夺。</p>
            </div>
          )}
        </aside>

        <section class="center-panel">
          <div class="panel-switcher">
            <button class={this.centerPanel === 'editor' ? 'active' : ''} onClick={() => { this.centerPanel = 'editor'; }}>标准步骤</button>
            <button class={this.centerPanel === 'checks' ? 'active' : ''} onClick={() => { this.centerPanel = 'checks'; }}>
              发布前检查 <span>{this.libChecks.length}</span>
            </button>
            <div class="version-tag">当前发布 <strong>v{course.currentVersion}</strong></div>
          </div>
          <div class="panel-scroll">
            {readOnly && (
              <div class="permission-callout danger">
                <strong>⛔ 越权修改已被拦截</strong>
                <span>你以任课老师身份打开课程库，所有标准步骤只读。请取用到个人课程后再修改，改好的步骤可申请回灌。</span>
              </div>
            )}
            {!readOnly && (
              <div class="permission-callout">
                <strong>教研组长工作稿</strong>
                <span>直接修改标准步骤不会立刻影响老师；点击"发布新版本"后才按版本号下发升级。</span>
              </div>
            )}
            {this.centerPanel === 'editor' && this.renderLibraryEditor(course, readOnly)}
            {this.centerPanel === 'checks' && this.renderChecks(this.libChecks)}
            {this.centerPanel === 'editor' && this.renderVersionHistory(course.versions)}
          </div>
        </section>

        {this.renderPreview()}
      </div>
    );
  }

  private renderLibraryEditor(course: LibraryCourse, readOnly: boolean) {
    const module = this.libModule;
    const step = this.libStep;
    if (!step || !module) {
      return <div class="empty-editor"><div class="empty-glyph">库</div><h2>还没有标准步骤</h2><p>{readOnly ? '课程库尚未发布内容。' : '新增模块和标准步骤，整理教研组统一课程。'}</p></div>;
    }
    return (
      <div class="step-editor">
        <div class="editor-title-row">
          <div>
            <span class="eyebrow">标准步骤 · {module.title}</span>
            <h1>{step.title}</h1>
            <p>库版本 v{step.version} · {course.status === 'published' ? '已发布，可继续编辑形成下一版' : '工作稿'}</p>
          </div>
        </div>
        <div class="form-card meta-card">
          <ion-input disabled={readOnly} label="课程标题" labelPlacement="stacked" class="studio-input" value={course.title} onIonInput={(e) => this.patchLibraryMeta({ title: e.detail.value ?? '' })} />
          <ion-textarea disabled={readOnly} autoGrow label="课程简介" labelPlacement="stacked" class="studio-input" value={course.summary} onIonInput={(e) => this.patchLibraryMeta({ summary: e.detail.value ?? '' })} />
          <ion-input disabled={readOnly} label="适用对象" labelPlacement="stacked" class="studio-input" value={course.audience} onIonInput={(e) => this.patchLibraryMeta({ audience: e.detail.value ?? '' })} />
        </div>
        {this.renderStepFields(step, (patch) => this.patchLibraryStep(patch), readOnly, module.steps)}
      </div>
    );
  }

  private renderVersionHistory(versions: CourseVersion[]) {
    return (
      <section class="form-card history-card">
        <div class="section-title"><span>史</span><div><h2>课程库发布历史</h2><p>每次发布产生一个新版本，老师个人副本据此升级</p></div></div>
        <div class="history-list">
          {versions.map((version) => (
            <div class="history-item">
              <strong>{version.label}</strong>
              <span>{version.note}</span>
              <small>{version.publishedBy} · {this.formatDate(version.publishedAt)}</small>
            </div>
          ))}
        </div>
      </section>
    );
  }

  // ── 渲染：个人课程 ──────────────────────────────────────────

  private renderMineView() {
    const course = this.personalCourse;
    if (!course) {
      return (
        <div class="empty-page">
          <div class="empty-glyph big">师</div>
          <h2>你名下还没有课程</h2>
          <p>可以从共享课程库取一份标准课程到自己名下，或从零创建个人课程。</p>
          <div class="empty-actions">
            <ion-button class="studio-button" onClick={() => { this.view = 'library'; this.bump(); }}>去课程库取用</ion-button>
            <ion-button fill="outline" class="studio-button" onClick={() => this.createPersonal()}>从零创建个人课程</ion-button>
          </div>
        </div>
      );
    }
    const status = this.store.courseUpgradeStatus(course.id);
    const library = course.libraryCourseId ? this.store.getLibraryCourse(course.libraryCourseId) : undefined;
    const module = this.personalModule;
    const step = this.personalStep;
    return (
      <div class="workspace">
        <aside class="left-panel">
          <div class="panel-head">
            <div><span class="eyebrow">我的课程</span><h2>{this.identity.name}名下</h2></div>
            <button class="small-add" onClick={() => this.createPersonal()}>＋课程</button>
          </div>
          <div class="course-list">
            {this.store.personalCourses.map((item) => {
              const upgrade = this.store.courseUpgradeStatus(item.id);
              return (
                <button class={`course-card ${item.id === course.id ? 'active' : ''}`} onClick={() => this.selectPersonalCourse(item.id)}>
                  <div class="course-card-row"><strong>{item.title}</strong></div>
                  <small>
                    {item.libraryCourseId ? `基于课程库 v${item.basedOnVersion ?? 1}` : '个人从零创建'}
                    {upgrade.conflicts > 0 ? ` · ${upgrade.conflicts} 处待裁定` : upgrade.behind > 0 ? ` · 库有 v${upgrade.libraryVersion}` : ''}
                  </small>
                </button>
              );
            })}
          </div>

          {this.store.workspace.migration && (
            <div class="migration-banner">
              <span class="eyebrow">旧数据迁移</span>
              <p>{this.store.workspace.migration.detail}</p>
              <small>{this.formatDate(this.store.workspace.migration.at)} 完成 · {this.store.workspace.migration.linkedSteps} 步挂接 / {this.store.workspace.migration.localSteps} 步个人保留</small>
            </div>
          )}

          <div class="module-list">
            {course.modules.map((item) => (
              <section class={`module-card ${item.id === module?.id ? 'active' : ''}`}>
                <button class="module-head" onClick={() => { this.selectedPersonalModuleId = item.id; this.selectedPersonalStepId = item.steps[0]?.id ?? ''; this.bump(); }}>
                  <span class="module-color" style={{ background: item.color }} />
                  <span><strong>{item.title}</strong><small>{item.steps.length} 个学习步骤</small></span>
                </button>
                {item.id === module?.id && (
                  <div class="step-list">
                    {item.steps.map((lesson) => {
                      const conflicting = course.conflicts.some((c) => c.stepId === lesson.id && !c.choice);
                      return (
                        <button class={`step-list-item ${lesson.id === step?.id ? 'active' : ''}`} onClick={() => { this.selectedPersonalStepId = lesson.id; this.bump(); }}>
                          <span class="step-copy">
                            <strong>{lesson.title}{conflicting ? <em class="conflict-flag">待裁定</em> : null}</strong>
                            <small>{lesson.kind} · <span class={`state-pill ${lesson.state}`}>{STEP_STATE_LABEL[lesson.state]}</span></small>
                          </span>
                        </button>
                      );
                    })}
                    <button class="inline-add" onClick={() => this.addPersonalStep('示范')}>＋ 学习步骤</button>
                  </div>
                )}
              </section>
            ))}
            <button class="block-add" onClick={() => this.addPersonalModule()}>＋ 新增个人模块</button>
          </div>

          <div class="panel-footer personal">
            {library ? (
              <div class="sync-line">
                <span>课程库最新 <strong>v{library.currentVersion}</strong>，本副本基于 <strong>v{course.basedOnVersion ?? 1}</strong></span>
                <ion-button size="small" fill="outline" class="studio-button" disabled={status.behind === 0 && status.conflicts === 0} onClick={() => this.pullUpdates()}>检查库更新</ion-button>
              </div>
            ) : <p class="hint">个人从零创建的课程不跟随课程库升级。</p>}
            <ion-button class="studio-button" color="primary" onClick={() => this.openBackfill()}>把改好的步骤申请回灌</ion-button>
          </div>
        </aside>

        <section class="center-panel">
          <div class="panel-switcher">
            <button class={this.centerPanel === 'editor' ? 'active' : ''} onClick={() => { this.centerPanel = 'editor'; }}>步骤编排</button>
            <button class={this.centerPanel === 'conflicts' ? 'active' : ''} onClick={() => { this.centerPanel = 'conflicts'; }}>
              版本冲突 {this.openConflicts.length > 0 && <span class="danger-badge">{this.openConflicts.length}</span>}
            </button>
            <button class={this.centerPanel === 'checks' ? 'active' : ''} onClick={() => { this.centerPanel = 'checks'; }}>
              发布前检查 <span>{this.personalChecks.length}</span>
            </button>
          </div>
          <div class="panel-scroll">
            {this.openConflicts.length > 0 && this.centerPanel !== 'conflicts' && (
              <div class="permission-callout warning" onClick={() => { this.centerPanel = 'conflicts'; }}>
                <strong>课程库发布了新版本</strong>
                <span>{this.openConflicts.length} 个你改过的步骤未被自动替换，点此对照两版并定夺。</span>
              </div>
            )}
            {this.centerPanel === 'editor' && this.renderPersonalEditor(course)}
            {this.centerPanel === 'conflicts' && this.renderConflicts(course)}
            {this.centerPanel === 'checks' && this.renderChecks(this.personalChecks)}
          </div>
        </section>

        {this.renderPreview()}
      </div>
    );
  }

  private renderPersonalEditor(course: PersonalCourse) {
    const module = this.personalModule;
    const step = this.personalStep;
    if (!module || !step) {
      return (
        <div class="empty-editor">
          <div class="empty-glyph">步</div>
          <h2>开始编排学习步骤</h2>
          <p>取用自课程库的步骤保持"未改动"时会自动跟随升级；一旦修改即转为"已自改"，库升级不会覆盖它。</p>
          <ion-button class="studio-button" onClick={() => this.addPersonalStep('示范')}>添加第一个步骤</ion-button>
        </div>
      );
    }
    return (
      <div class="step-editor">
        <div class="editor-title-row">
          <div>
            <span class="eyebrow">学习步骤 · {module.title}</span>
            <h1>{step.title}</h1>
            <p>
              <span class={`state-pill ${step.state}`}>{STEP_STATE_LABEL[step.state]}</span>
              {step.originVersion ? ` · 对应课程库 v${step.originVersion}` : ' · 课程库中无对应步骤'}
              {' '}· 最后保存 {this.formatDate(course.lastSavedAt)}
            </p>
          </div>
          <div class="title-actions">
            <ion-button fill="clear" class="studio-button" onClick={() => this.run(() => this.store.movePersonalStep(course.id, module.id, step.id, -1))}>上移</ion-button>
            <ion-button fill="clear" class="studio-button" onClick={() => this.run(() => this.store.movePersonalStep(course.id, module.id, step.id, 1))}>下移</ion-button>
            <ion-button fill="outline" color="danger" class="studio-button" onClick={() => this.deletePersonalStep()}>删除</ion-button>
          </div>
        </div>
        <div class="form-card meta-card">
          <ion-input label="我的课程标题" labelPlacement="stacked" class="studio-input" value={course.title} onIonInput={(e) => this.patchPersonalMeta({ title: e.detail.value ?? '' })} />
          <ion-input label="适用对象" labelPlacement="stacked" class="studio-input" value={course.audience} onIonInput={(e) => this.patchPersonalMeta({ audience: e.detail.value ?? '' })} />
        </div>
        {this.renderStepFields(step, (patch) => this.patchPersonalStep(patch), false, module.steps)}
      </div>
    );
  }

  private renderConflicts(course: PersonalCourse) {
    const open = course.conflicts.filter((item) => !item.choice);
    const resolved = course.conflicts.filter((item) => item.choice);
    if (!open.length && !resolved.length) {
      return <div class="empty-editor"><div class="empty-glyph">✓</div><h2>没有版本冲突</h2><p>课程库发布新版本后，你改过且与新版不同的步骤会在这里摆出两版，由你决定保留哪一版。</p></div>;
    }
    return (
      <div class="conflicts-view">
        {open.map((conflict) => {
          const module = course.modules.find((m) => m.id === conflict.moduleId);
          return (
            <section class="conflict-card" key={conflict.stepId}>
              <div class="conflict-head">
                <div><span class="eyebrow">{module?.title}</span><h2>{conflict.mineStep.title}</h2></div>
                <span class="conflict-tag">库 v{conflict.libraryVersion} 与你的自改不同</span>
              </div>
              <div class="diff-grid">
                <div class="diff-col mine">
                  <header><span class="state-pill dirty">我的版本</span><small>不会被自动替换</small></header>
                  {this.renderStepDiff(conflict.mineStep, conflict.libraryStep)}
                  <ion-button class="studio-button" onClick={() => this.resolveConflict(conflict.stepId, 'mine')}>保留我的版本</ion-button>
                </div>
                <div class="diff-col library">
                  <header><span class="state-pill clean">课程库 v{conflict.libraryVersion}</span><small>组长新发布</small></header>
                  {this.renderStepDiff(conflict.libraryStep, conflict.mineStep)}
                  <ion-button fill="outline" class="studio-button" onClick={() => this.resolveConflict(conflict.stepId, 'library')}>采用库新版本</ion-button>
                </div>
              </div>
            </section>
          );
        })}
        {resolved.length > 0 && (
          <section class="form-card">
            <div class="section-title"><span>定</span><div><h2>已裁定（{resolved.length}）</h2><p>你的选择已记录，后续版本仍会在内容再次分叉时提示</p></div></div>
            {resolved.map((item) => (
              <div class="resolved-row" key={item.stepId}>
                <strong>{item.mineStep.title}</strong>
                <span class={`state-pill ${item.choice === 'mine' ? 'dirty' : 'clean'}`}>{item.choice === 'mine' ? '保留了我的版本' : '采用了库新版本'}</span>
                <small>{item.resolvedAt ? this.formatDate(item.resolvedAt) : ''}</small>
              </div>
            ))}
          </section>
        )}
      </div>
    );
  }

  private renderStepDiff(step: LessonStep, other: LessonStep) {
    const fields: { label: string; mine: string; lib: string }[] = [
      { label: '步骤类型', mine: step.kind, lib: other.kind },
      { label: '时长（秒）', mine: String(step.duration), lib: String(other.duration) },
      { label: '难度', mine: step.difficulty, lib: other.difficulty },
      { label: '镜头角度', mine: step.camera, lib: other.camera },
      { label: '字幕位置', mine: step.captionPosition, lib: other.captionPosition },
      { label: '手形说明', mine: step.handshape, lib: other.handshape },
      { label: '字幕', mine: step.caption, lib: other.caption },
      { label: '替代文本', mine: step.altText, lib: other.altText },
      { label: '练习任务', mine: step.exercise, lib: other.exercise },
      { label: '练习反馈', mine: step.exerciseFeedback, lib: other.exerciseFeedback },
    ];
    return (
      <dl class="diff-list">
        {fields.map((field) => {
          const changed = field.mine !== field.lib;
          return (
            <div class={changed ? 'changed' : ''}>
              <dt>{field.label}{changed ? <em>不同</em> : null}</dt>
              <dd>{field.mine || '—'}</dd>
            </div>
          );
        })}
      </dl>
    );
  }

  // ── 渲染：共用表单 / 检查 / 预览 ────────────────────────────

  private renderStepFields(step: LessonStep, onChange: (patch: Partial<LessonStep>) => void, disabled: boolean, siblings: LessonStep[]) {
    const index = siblings.findIndex((item) => item.id === step.id);
    const prerequisites = siblings.filter((item, i) => item.id !== step.id && i < index);
    return [
      <section class="form-card">
        <div class="section-title"><span>01</span><div><h2>基础设计</h2><p>标题、类型、难度和预计时长</p></div></div>
        <div class="form-grid two">
          <ion-input disabled={disabled} label="步骤标题" labelPlacement="stacked" class="studio-input" value={step.title} onIonInput={(e) => onChange({ title: e.detail.value ?? '' })} />
          <ion-select disabled={disabled} label="步骤类型" labelPlacement="stacked" class="studio-input" value={step.kind} onIonChange={(e) => onChange({ kind: e.detail.value as LessonStep['kind'] })}>
            {['示范', '讲解', '练习'].map((kind) => <ion-select-option value={kind}>{kind}</ion-select-option>)}
          </ion-select>
          <ion-select disabled={disabled} label="难度标签" labelPlacement="stacked" class="studio-input" value={step.difficulty} onIonChange={(e) => onChange({ difficulty: e.detail.value as Difficulty })}>
            {(['入门', '进阶', '挑战'] as Difficulty[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
          </ion-select>
          <ion-input disabled={disabled} type="number" min="10" max="600" label="预计时长（秒）" labelPlacement="stacked" class="studio-input" value={String(step.duration)} onIonInput={(e) => onChange({ duration: Number(e.detail.value) || 0 })} />
        </div>
      </section>,

      <section class="form-card">
        <div class="section-title"><span>02</span><div><h2>示范片段与镜头</h2><p>记录素材标识、手形、镜头角度和动作区域</p></div></div>
        <div class="demo-row">
          <div class={`video-thumbnail zone-${step.gestureZone}`}>
            <span class="play-mark">▶</span>
            <strong>{step.kind}片段</strong>
            <small>{step.camera}</small>
          </div>
          <div class="demo-fields">
            <ion-input disabled={disabled} label="示范片段名称" labelPlacement="stacked" class="studio-input" value={step.demoTitle} onIonInput={(e) => onChange({ demoTitle: e.detail.value ?? '' })} />
            <ion-input disabled={disabled} label="本地素材地址（可空）" labelPlacement="stacked" class="studio-input" value={step.demoUrl} onIonInput={(e) => onChange({ demoUrl: e.detail.value ?? '' })} />
          </div>
        </div>
        <div class="form-grid two">
          <ion-select disabled={disabled} label="镜头角度" labelPlacement="stacked" class="studio-input" value={step.camera} onIonChange={(e) => onChange({ camera: e.detail.value as CameraAngle })}>
            {(['正面', '左侧 45°', '右侧 45°', '俯拍手部', '全身远景'] as CameraAngle[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
          </ion-select>
          <ion-select disabled={disabled} label="主要手形区域" labelPlacement="stacked" class="studio-input" value={step.gestureZone} onIonChange={(e) => onChange({ gestureZone: e.detail.value as GestureZone })}>
            {(['左侧', '中央', '右侧'] as GestureZone[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
          </ion-select>
        </div>
        <ion-textarea disabled={disabled} autoGrow label="手形说明" labelPlacement="stacked" class="studio-input" value={step.handshape} onIonInput={(e) => onChange({ handshape: e.detail.value ?? '' })} />
      </section>,

      <section class="form-card">
        <div class="section-title"><span>03</span><div><h2>字幕与无障碍</h2><p>检查字幕位置、动作遮挡与替代文本</p></div></div>
        <div class="form-grid two">
          <ion-select disabled={disabled} label="字幕位置" labelPlacement="stacked" class="studio-input" value={step.captionPosition} onIonChange={(e) => onChange({ captionPosition: e.detail.value as CaptionPosition })}>
            {(['下方安全区', '上移 15%', '角标提示', '画面中央'] as CaptionPosition[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
          </ion-select>
          <ion-input disabled={disabled} label="替代文本状态" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText ? '已填写' : '缺失'} readonly />
        </div>
        <ion-textarea disabled={disabled} autoGrow label="步骤字幕" labelPlacement="stacked" class="studio-input" value={step.caption} onIonInput={(e) => onChange({ caption: e.detail.value ?? '' })} />
        <ion-textarea disabled={disabled} autoGrow label="替代文本（必须描述动作与表情）" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText} onIonInput={(e) => onChange({ altText: e.detail.value ?? '' })} />
      </section>,

      <section class="form-card">
        <div class="section-title"><span>04</span><div><h2>学习依赖与练习</h2><p>前置步骤、常见错误、练习任务与反馈</p></div></div>
        <div class="form-grid two">
          <ion-select disabled={disabled} label="前置条件" labelPlacement="stacked" class="studio-input" value={step.prerequisiteId} onIonChange={(e) => onChange({ prerequisiteId: e.detail.value ?? '' })}>
            <ion-select-option value="">无前置条件</ion-select-option>
            {prerequisites.map((item) => <ion-select-option value={item.id}>{item.title}</ion-select-option>)}
          </ion-select>
          <ion-input disabled={disabled} label="检查点（秒，用逗号分隔）" labelPlacement="stacked" class="studio-input" value={step.cuePoints.join(', ')} onIonInput={(e) => onChange({ cuePoints: (e.detail.value ?? '').split(/[,，\s]+/).map(Number).filter((v) => Number.isFinite(v)) })} />
        </div>
        <ion-textarea disabled={disabled} autoGrow label="常见错误（每行一条）" labelPlacement="stacked" class="studio-input" value={step.commonMistakes.join('\n')} onIonInput={(e) => onChange({ commonMistakes: (e.detail.value ?? '').split('\n').filter(Boolean) })} />
        <div class="form-grid two">
          <ion-textarea disabled={disabled} autoGrow label="练习任务" labelPlacement="stacked" class="studio-input" value={step.exercise} onIonInput={(e) => onChange({ exercise: e.detail.value ?? '' })} />
          <ion-textarea disabled={disabled} autoGrow label="练习反馈" labelPlacement="stacked" class="studio-input" value={step.exerciseFeedback} onIonInput={(e) => onChange({ exerciseFeedback: e.detail.value ?? '' })} />
        </div>
      </section>,
    ];
  }

  private renderChecks(checks: ValidationCheck[]) {
    return (
      <section class="checks-panel">
        <div class="check-list">
          {checks.length === 0 && <div class="all-clear"><strong>✓ 未发现问题</strong><p>字幕遮挡、步骤跳级和替代文本检查均已通过。</p></div>}
          {checks.map((check) => (
            <div class={`check-item ${check.severity}`}>
              <span class="check-severity">{check.severity === 'error' ? '!' : check.severity === 'warning' ? '△' : 'i'}</span>
              <span><strong>{check.title}</strong><small>{check.detail}</small></span>
            </div>
          ))}
        </div>
      </section>
    );
  }

  private renderPreview() {
    const step = this.activeStep;
    const progress = Math.round(this.playProgress * 100);
    return (
      <section class="preview-panel">
        <div class="preview-head">
          <div><span class="eyebrow">学习者预览</span><h2>设备与安全区检查</h2></div>
          <ion-segment value={this.previewSize} class="studio-segment" onIonChange={(e) => { this.previewSize = e.detail.value as PreviewSize; }}>
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
        ) : <div class="empty-preview">选择步骤后显示设备预览。</div>}
      </section>
    );
  }

  // ── 渲染：回灌申请 ──────────────────────────────────────────

  private renderRequestsView() {
    const requests = this.isLeader
      ? this.store.requests
      : this.store.requests.filter((request) => request.teacherId === this.identity.id);
    const hasPending = requests.some((request) => request.items.some((item) => item.status === 'pending' || item.status === 'failed'));
    return (
      <div class="requests-page">
        <div class="requests-head">
          <div>
            <span class="eyebrow">{this.isLeader ? '教研组长审核' : '老师回灌追踪'}</span>
            <h1>{this.isLeader ? '回灌到课程库的申请' : '我的回灌申请'}</h1>
            <p>申请按学习步骤逐项补入课程库；单项失败不影响其他步骤，申请会一直保留到课程库恢复。</p>
          </div>
          {hasPending && (
            <ion-button class="studio-button" disabled={!this.store.workspace.libraryOnline} onClick={() => this.retryBackfills()}>
              {this.store.workspace.libraryOnline ? '立即重试待补步骤' : '课程库中断中，等待自动恢复'}
            </ion-button>
          )}
        </div>
        {!this.store.workspace.libraryOnline && (
          <div class="permission-callout warning">
            <strong>课程库当前不可用</strong>
            <span>新申请会以"待补入"状态保留；恢复连接后系统自动按学习步骤逐项补上，也可点上方按钮立即重试。</span>
          </div>
        )}
        {requests.length === 0 && <div class="all-clear"><strong>暂无回灌申请</strong><p>老师在个人课程里改好标准步骤后即可发起申请。</p></div>}
        {requests.map((request) => (
          <section class="request-card" key={request.id}>
            <header>
              <div><strong>{request.courseTitle}</strong><small>{request.teacherName} · {this.formatDate(request.createdAt)}</small></div>
              <span class="request-note">{request.note || '未附说明'}</span>
            </header>
            <div class="request-items">
              {request.items.map((item) => (
                <div class={`request-item ${item.status}`} key={item.id}>
                  <span class="request-step">{item.stepTitle}</span>
                  <span class={`request-status ${item.status}`}>{this.itemStatusLabel(item.status)}</span>
                  {item.error && <small class="request-error">{item.error}</small>}
                  {item.attempts > 1 && <small class="request-attempts">已重试 {item.attempts - 1} 次</small>}
                  {this.isLeader && (item.status === 'applied') && (
                    <span class="review-actions">
                      <ion-button size="small" class="studio-button" onClick={() => this.run(() => this.store.reviewBackfillItem(request.id, item.id, true))}>确认保留</ion-button>
                      <ion-button size="small" fill="outline" color="danger" class="studio-button" onClick={() => this.run(() => this.store.reviewBackfillItem(request.id, item.id, false))}>退回该步</ion-button>
                    </span>
                  )}
                  {this.isLeader && item.status === 'rejected' && <small class="request-error">已退回：{item.error}</small>}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  }

  private itemStatusLabel(status: string): string {
    switch (status) {
      case 'pending': return '待补入（申请已留存）';
      case 'failed': return '补入失败 · 等待重试';
      case 'applied': return this.isLeader ? '已补入工作稿 · 待发布' : '已补入课程库 · 待组长发布';
      case 'rejected': return '已被组长退回';
      default: return status;
    }
  }

  // ── 弹窗 ────────────────────────────────────────────────────

  private renderModals() {
    if (this.showPublishModal) {
      return (
        <div class="modal-mask" onClick={() => { this.showPublishModal = false; }}>
          <div class="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>发布课程库新版本</h2>
            <p>即将发布 <strong>v{(this.libraryCourse?.currentVersion ?? 1) + 1}</strong>。老师名下没动过的步骤自动升级；动过的步骤保持不变并进入两版对照。</p>
            <ion-textarea autoGrow label="版本说明（老师会看到）" labelPlacement="stacked" class="studio-input" placeholder="例如：放慢问候示范节奏，更新手部近景镜头" value={this.publishNote} onIonInput={(e) => { this.publishNote = e.detail.value ?? ''; }} />
            <div class="modal-actions">
              <ion-button fill="clear" class="studio-button" onClick={() => { this.showPublishModal = false; }}>取消</ion-button>
              <ion-button class="studio-button" onClick={() => this.confirmPublish()}>确认发布</ion-button>
            </div>
          </div>
        </div>
      );
    }
    if (this.showBackfillModal) {
      const course = this.personalCourse;
      const eligible = course?.modules.flatMap((module) =>
        module.steps.filter((step) => step.state !== 'local' && step.state !== 'clean').map((step) => ({ module, step })),
      ) ?? [];
      const pickedCount = Object.values(this.backfillSelected).filter(Boolean).length;
      return (
        <div class="modal-mask" onClick={() => { this.showBackfillModal = false; }}>
          <div class="modal-card large" onClick={(e) => e.stopPropagation()}>
            <h2>申请回灌到共享课程库</h2>
            <p>勾选你改过、希望教研组采纳进标准课程的学习步骤。课程库不可用时申请也会先留存，恢复后逐项补入。</p>
            <div class="pick-list">
              {eligible.map(({ module, step }) => (
                <label class={`pick-row ${this.backfillSelected[step.id] ? 'on' : ''}`}>
                  <input type="checkbox" checked={Boolean(this.backfillSelected[step.id])} onChange={() => this.toggleBackfillPick(step.id)} />
                  <span><strong>{step.title}</strong><small>{module.title} · <span class={`state-pill ${step.state}`}>{STEP_STATE_LABEL[step.state]}</span> · 对应库 v{step.originVersion}</small></span>
                </label>
              ))}
            </div>
            <ion-textarea autoGrow label="给教研组长的说明" labelPlacement="stacked" class="studio-input" placeholder="例如：课堂上发现原版节奏偏快，已放慢到 50 秒并补充两个常见错误" value={this.backfillNote} onIonInput={(e) => { this.backfillNote = e.detail.value ?? ''; }} />
            <div class="modal-actions">
              <ion-button fill="clear" class="studio-button" onClick={() => { this.showBackfillModal = false; }}>取消</ion-button>
              <ion-button class="studio-button" disabled={pickedCount === 0} onClick={() => this.submitBackfill()}>提交申请（{pickedCount} 个步骤）</ion-button>
            </div>
          </div>
        </div>
      );
    }
    return null;
  }

  render() {
    void this.rev;
    return (
      <Host>
        <ion-app>
          {this.renderHeader()}
          {this.renderSubNav()}
          <ion-content fullscreen class="studio-content">
            {this.view === 'library' && this.renderLibraryView()}
            {this.view === 'mine' && !this.isLeader && this.renderMineView()}
            {this.view === 'requests' && this.renderRequestsView()}
          </ion-content>
          <ion-toast isOpen={Boolean(this.toast)} message={this.toast?.message} color={this.toast?.color} duration={3600} onDidDismiss={() => { this.toast = undefined; }} />
          {this.renderModals()}
        </ion-app>
      </Host>
    );
  }
}
