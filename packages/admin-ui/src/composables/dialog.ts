import { ref, type Ref } from 'vue';

/** 对话框请求描述：confirm 只需 ok/cancel，prompt 带输入框 */
interface DialogRequest {
  /** 标题/提示文案 */
  message: string;
  /** 是否带输入框（prompt 语义） */
  input?: boolean;
  /** 输入框初始值 */
  defaultValue?: string;
  /** 危险操作（删除等）显示红色确认按钮 */
  danger?: boolean;
  /** 确认按钮文案 */
  okText?: string;
  /** 完成时回传：confirm → boolean；prompt → string | null（null=取消） */
  resolve: (v: any) => void;
}

const current: Ref<DialogRequest | null> = ref(null);
const inputValue = ref('');

/** 关闭并回传取消（点遮罩/取消按钮/Escape） */
function cancel(): void {
  current.value?.resolve(null);
  current.value = null;
}

/** 关闭并回传确认值 */
function ok(): void {
  if (!current.value) return;
  current.value.resolve(current.value.input ? inputValue.value : true);
  current.value = null;
}

/** 打开确认框：resolve(true)=确认，resolve(null)=取消 */
function confirmDialog(message: string, opts: { danger?: boolean; okText?: string } = {}): Promise<boolean> {
  return new Promise(resolve => {
    current.value = { message, resolve: v => resolve(v === true), ...opts };
  });
}

/** 打开输入框：resolve(string)=确认，resolve(null)=取消 */
function promptDialog(message: string, defaultValue = ''): Promise<string | null> {
  return new Promise(resolve => {
    inputValue.value = defaultValue;
    current.value = { message, input: true, resolve };
  });
}

export { current, inputValue, cancel, ok, confirmDialog, promptDialog };
