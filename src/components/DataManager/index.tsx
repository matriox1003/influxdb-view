import { useRef, useState } from 'react';
import { Button, Select, Text, Alert, Group } from '@mantine/core';
import { IconPlayerPlayFilled, IconUpload } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useConnectionStore } from '@/store/useConnectionStore';
import { useDatabaseStore } from '@/store/useDatabaseStore';
import { getApi } from '@/types';
import { sqlToLineProtocol } from './sqlToLineProtocol';

const SAMPLE = `-- 类 SQL 写法（底层自动转成 Line Protocol 写入）
-- 语法：INSERT INTO measurement(tag=v, ...) field=v, ... [时间戳]
INSERT INTO cpu(host=server01, region=us-west) value=0.64
INSERT INTO temperature(sensor=s1) value=23.5, status="ok" 1700000001000000000
INSERT INTO log(level=info, app=api) msg="hello world"`;

interface Props {
  onClose: () => void;
}

export function DataManager({ onClose }: Props) {
  const activeConn = useConnectionStore((s) => s.connections.find((c) => c.id === s.activeId));
  const [database, setDatabase] = useState(activeConn?.database || '');
  const [text, setText] = useState(SAMPLE);
  const databases =
    useDatabaseStore((s) => (activeConn?.id ? s.byConnection[activeConn.id] : undefined)) || [];
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [convertErrors, setConvertErrors] = useState<string[] | null>(null);
  const [writing, setWriting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const ensureDbs = () => {
    if (activeConn?.id) void useDatabaseStore.getState().load(activeConn.id);
  };

  const write = async (sqlText: string) => {
    if (!activeConn?.id) {
      notifications.show({ color: 'yellow', message: '请先选择连接' });
      return;
    }
    if (!database) {
      notifications.show({ color: 'yellow', message: '请选择目标数据库' });
      return;
    }
    // 类 SQL → Line Protocol
    const { lines, errors } = sqlToLineProtocol(sqlText);
    setConvertErrors(errors.length ? errors.map((e) => `第 ${e.lineNo} 行：${e.reason} —— ${e.raw}`) : null);
    if (errors.length) {
      notifications.show({ color: 'yellow', message: `${errors.length} 行语法错误，已忽略这些行` });
    }
    if (lines.length === 0) {
      notifications.show({ color: 'yellow', message: '没有可写入的有效语句' });
      return;
    }
    setWriting(true);
    setResult(null);
    try {
      await getApi().write({ connectionId: activeConn.id, database, lines: lines.join('\n') });
      setResult({ ok: true, msg: `成功写入 ${lines.length} 个数据点` });
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setWriting(false);
    }
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ''));
    reader.readAsText(file);
  };

  if (!activeConn?.id) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--iv-text-3)' }}>请先选择连接</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--iv-bg-elevated)' }}>
      {/* 工具栏 */}
      <div className="iv-toolbar" style={{ height: 38, gap: 6, borderBottom: '1px solid var(--iv-border)' }}>
        <Select
          placeholder="选择数据库"
          style={{ width: 180 }}
          size="sm"
          value={database || undefined}
          onChange={(v) => setDatabase(v ?? '')}
          onDropdownOpen={ensureDbs}
          searchable
          data={databases}
        />
        <Button size="sm" variant="subtle" leftSection={<IconUpload size={14} />} onClick={() => fileRef.current?.click()}>
          导入文件
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.sql,.lp,.log"
          style={{ display: 'none' }}
          onChange={handleFile}
        />
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="default" onClick={onClose}>
          关闭
        </Button>
      </div>

      {/* 语法说明 */}
      <div
        style={{
          padding: '6px 12px',
          background: 'var(--mantine-color-gray-0)',
          borderBottom: '1px solid var(--iv-border)',
          fontSize: 12,
          color: 'var(--iv-text-3)',
          lineHeight: 1.7,
          flexShrink: 0,
        }}
      >
        语法：<code style={{ color: 'var(--mantine-primary-color-filled)' }}>INSERT INTO measurement(tag=v, ...) field=v, ... [时间戳]</code>
        ；标签写括号里、字段写括号外；时间戳可选（默认服务端时间）。<code>#</code> / <code>--</code> 为注释。
      </div>

      {/* 编辑区：textarea 用绝对定位填充父容器，避免 flex 下高度塌缩 */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', margin: '8px 0' }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            resize: 'none',
            fontFamily: 'monospace',
            fontSize: 13,
            lineHeight: 1.6,
            padding: 12,
            border: '1px solid var(--iv-border)',
            borderRadius: 4,
            background: 'var(--iv-bg-panel)',
            color: 'var(--iv-text-1)',
            boxSizing: 'border-box',
          }}
          placeholder="每行一条 INSERT INTO ... 语句"
        />
      </div>

      {/* 提示区：转换错误 / 写入结果（放在编辑区下方，正常文档流） */}
      <div style={{ padding: '0 12px', flexShrink: 0 }}>
        {convertErrors && convertErrors.length > 0 && (
          <Alert
            color="yellow"
            variant="light"
            mb="xs"
            withCloseButton
            onClose={() => setConvertErrors(null)}
            title={`${convertErrors.length} 行转换失败`}
          >
            <div style={{ fontSize: 12, fontFamily: 'monospace' }}>
              {convertErrors.slice(0, 5).map((e, i) => (
                <div key={i}>{e}</div>
              ))}
              {convertErrors.length > 5 && <div>…还有 {convertErrors.length - 5} 行</div>}
            </div>
          </Alert>
        )}

        {result && (
          <Alert
            color={result.ok ? 'green' : 'red'}
            variant="light"
            mb="xs"
            title={result.ok ? '写入成功' : '写入失败'}
          >
            {result.msg}
          </Alert>
        )}
      </div>

      {/* 底部操作 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 12px', flexShrink: 0 }}>
        <Group>
          <Button leftSection={<IconPlayerPlayFilled size={14} />} loading={writing} onClick={() => void write(text)}>
            写入
          </Button>
        </Group>
      </div>
    </div>
  );
}
