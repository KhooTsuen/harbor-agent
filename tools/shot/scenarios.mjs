/**
 * 截图场景清单（浏览器预览）
 *
 * 从 shot.mjs 拆出来的（那边过 300 行了）。
 *
 * 每项是 `{ name, script }`：script 为 null 表示只截初始状态，
 * 否则先在页面里执行那段 JS 再截。加场景就往这个数组里加一条。
 */

const SHOTS = [
  { name: '01-主界面', script: null },
  /* 切到 Markdown 自检会话并滚到顶部：验标题/粗体/任务列表 */
  {
    name: '01b-markdown-顶部',
    script: `
      const rows = [...document.querySelectorAll('button, [role=\"button\"], div')]
        .filter(el => el.textContent && el.textContent.trim().startsWith('Markdown 渲染自检'));
      if (rows.length) rows[rows.length - 1].click();
      document.querySelectorAll('*').forEach(el => { if (el.scrollHeight > el.clientHeight + 80) el.scrollTop = 0; });
    `,
  },
  {
    name: '02-空对话',
    script: `(function () {
      const btns = [...document.querySelectorAll('button')];
      const b = btns.find((x) => x.textContent.includes('新建对话'));
      if (b) b.click();
      return '新建对话';
    })()`,
  },
  {
    name: '03-设置-外观',
    script: `(function () {
      const btns = [...document.querySelectorAll('button')];
      const s = btns.find((x) => x.getAttribute('aria-label') === '设置');
      if (s) s.click();
      return 'ok';
    })()`,
  },
  {
    name: '04-设置-外观标签',
    script: `(function () {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find((x) => x.textContent.trim() === '外观');
      if (t) t.click();
      return 'ok';
    })()`,
  },
  {
    name: '05-玻璃拟态-开',
    script: `(function () {
      document.documentElement.dataset.glass = 'on';
      const el = document.querySelector('.glass');
      return el ? 'glass 元素存在' : '没有 .glass';
    })()`,
  },
  {
    name: '06-命令面板',
    script: `(function () {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      return 'sent';
    })()`,
  },
  {
    name: '07-终端标签',
    script: `(function () {
      document.documentElement.dataset.glass = 'off';
      // 关掉所有弹窗
      document.querySelectorAll('[role="dialog"]').forEach((d) => {
        const close = d.querySelector('button[aria-label="关闭"]');
        if (close) close.click();
      });
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find((x) => x.textContent.trim().startsWith('终端'));
      if (t) t.click();
      return 'ok';
    })()`,
  },
  {
    name: '07b-浏览器标签',
    script: `(function () {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find((x) => x.textContent.trim() === '浏览器');
      if (t) t.click();
      return 'ok';
    })()`,
  },
  {
    name: '08-文件树',
    script: `(function () {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find((x) => x.textContent.trim().startsWith('文件'));
      if (t) t.click();
      return 'ok';
    })()`,
  },
  {
    name: '09-亮色主题',
    script: `(function () {
      document.documentElement.dataset.theme = 'light';
      return 'light';
    })()`,
  },
  {
    name: '10-spec主题',
    script: `(function () {
      document.documentElement.dataset.theme = 'spec';
      return 'spec';
    })()`,
  },
  {
    /* 回归用：玻璃开启时 Composer 的模式菜单是否被裁切 */
    name: '11-Composer菜单-玻璃开',
    script: `(function () {
      document.documentElement.dataset.theme = 'default';
      document.documentElement.dataset.glass = 'on';
      const btns = [...document.querySelectorAll('button')];
      const trigger = btns.find((b) => b.textContent.trim().startsWith('结对'));
      if (trigger) trigger.click();
      return trigger ? 'clicked' : 'not-found';
    })()`,
  },
  {
    name: '11b-模型菜单-级联',
    script: `(function () {
      document.documentElement.dataset.glass = 'off';
      const t = document.querySelector('[data-model-trigger="true"]');
      if (t) t.click();
      return t ? 'clicked' : 'not-found';
    })()`,
  },
  {
    name: '12-设置-外观',
    script: `(function () {
      document.documentElement.dataset.glass = 'off';
      document.querySelectorAll('[role="dialog"]').forEach((d) => {
        const c = d.querySelector('button[aria-label="关闭"]');
        if (c) c.click();
      });
      const btns = [...document.querySelectorAll('button')];
      const s = btns.find((x) => x.getAttribute('aria-label') === '设置');
      if (s) s.click();
      return 'ok';
    })()`,
  },
  {
    /* 回归用：切到内容较少的「通用」页，看弹窗高度是否和「外观」页一致 */
    name: '13-设置-通用',
    script: `(function () {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find((x) => x.textContent.trim() === '通用');
      if (t) t.click();
      return 'ok';
    })()`,
  },
  {
    /* 设置 → 模型：助手参数（模型可输入 + 获取模型按钮） */
    name: '13b-设置-模型',
    script: `(function () {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find((x) => x.textContent.trim() === '模型');
      if (t) t.click();
      return 'ok';
    })()`,
  },
  {
    name: '15-设置-技能',
    script: `(function () {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find((x) => x.textContent.trim() === '技能');
      if (t) t.click();
      return 'ok';
    })()`,
  },
  {
    name: '16-设置-记忆',
    script: `(function () {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find((x) => x.textContent.trim() === '记忆');
      if (t) t.click();
      return 'ok';
    })()`,
  },
  {
    name: '17-设置-扩展',
    script: `(function () {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find((x) => x.textContent.trim() === '扩展');
      if (t) t.click();
      return 'ok';
    })()`,
  },
  {
    name: '18-设置-用量',
    script: `(function () {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find((x) => x.textContent.trim() === '用量');
      if (t) t.click();
      return 'ok';
    })()`,
  },
  {
    name: '19-首次启动引导',
    script: `(function () {
      // 引导只看 general.onboarded。演示模式下 config 是 localStorage 里的，
      // 改成 false 再刷新就能看到真实的第一屏
      const raw = localStorage.getItem('personal-agent:settings');
      if (raw) {
        try {
          const s = JSON.parse(raw);
          s.state = s.state || {};
          s.state.settings = s.state.settings || {};
        } catch (e) { /* 解析不了就算了 */ }
      }
      return 'need-reload';
    })()`,
  },
  {
    name: '14-设置-数据',
    script: `(function () {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find((x) => x.textContent.trim() === '数据');
      if (t) t.click();
      return 'ok';
    })()`,
  },
]

export { SHOTS }
