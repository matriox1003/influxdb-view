import { createTheme, type MantineColorsTuple } from '@mantine/core';

/**
 * 黑白主题（Mantine 全局主题）：
 * - primary 为中性色板（黑白灰），选中态/链接/焦点环等主色视觉全部走黑白
 * - 按钮黑白反转：亮色模式黑底白字，暗色模式白底黑字
 * - light 模式 primary 取色板最深（黑），dark 模式取最浅（白）
 */
const neutral: MantineColorsTuple = [
  '#f7f7f7',
  '#eaeaea',
  '#d8d8d8',
  '#c1c1c1',
  '#a5a5a5',
  '#828282',
  '#5e5e5e',
  '#3b3b3b',
  '#202020',
  '#0d0d0d',
];

export const theme = createTheme({
  primaryColor: 'neutral',
  primaryShade: { light: 9, dark: 0 },
  colors: { neutral },
  defaultRadius: 'sm',
  components: {
    // Modal 默认垂直居中（Mantine 默认贴顶，全局统一改为居中弹窗）
    Modal: { defaultProps: { centered: true } },
  },
  // 黑白按钮的实现在 global.css：覆盖 --button-bg/--button-color 变量
  // （Mantine 的 inline CSS 变量优先级高于 theme styles，CSS !important 才可靠）
});
