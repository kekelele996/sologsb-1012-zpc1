import { newSpecPage } from '@stencil/core/testing';
import { AppRoot } from './app-root';

beforeEach(() => localStorage.clear());

describe('app-root 渲染冒烟', () => {
  it('老师身份默认看到迁移后的个人课程与冲突编排入口', async () => {
    const page = await newSpecPage({ components: [AppRoot], html: '<app-root></app-root>' });
    expect(page.root).toBeTruthy();
    const text = page.root?.textContent ?? '';
    expect(text).toContain('SignCourse Studio');
    expect(text).toContain('我的课程');
    expect(text).toContain('旧数据迁移');
    expect(text).not.toContain('越权修改已被拦截'); // 老师默认进入自己的课程视图
  });

  it('切换到教研组长后显示课程库发布入口', async () => {
    const page = await newSpecPage({ components: [AppRoot], html: '<app-root></app-root>' });
    const instance = page.rootInstance as unknown as {
      switchIdentity: (id: string) => void;
    };
    instance.switchIdentity('leader-chen');
    await page.waitForChanges();
    const text = page.root?.textContent ?? '';
    expect(text).toContain('共享课程库');
    expect(text).toContain('发布新版本');
  });
});
