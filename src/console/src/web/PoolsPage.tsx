import { useEffect, useState } from 'react';
import type { ProxyAccountDto } from '@ghcp/shared';
import {
  addPoolMember,
  createPool,
  deletePool,
  listPools,
  listProxyAccounts,
  pruneSessionAffinity,
  removePoolMember,
  resumePoolMember,
  updatePool,
  type PoolDto,
  type PoolMemberDto,
  type PoolStrategy,
} from './api/proxy.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Input } from './components/ui/input.js';

type Notify = (message: string, tone?: 'success' | 'warning' | 'error') => void;

const STRATEGY_LABEL: Record<PoolStrategy, string> = {
  'least-loaded': '最少使用（推荐）',
  'sticky-affinity': '会话粘性',
  'round-robin': '轮询',
};

const STRATEGY_HINT: Record<PoolStrategy, string> = {
  'least-loaded': '每次挑最久未使用的账号，负载最均匀。多租户共用一个池时用这个',
  'sticky-affinity': '同一会话固定落在同一账号。需要按会话审计追溯、或客户端用了 /responses 的 previous_response_id 这类有状态接口时用',
  'round-robin': '按会话哈希分配，同一会话结果稳定但不看负载',
};

export function PoolsPage(props: { notify: Notify }) {
  const [pools, setPools] = useState<PoolDto[]>([]);
  const [accounts, setAccounts] = useState<ProxyAccountDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [newPoolId, setNewPoolId] = useState('');
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [poolResult, accountResult] = await Promise.all([
        listPools(),
        listProxyAccounts({ pageSize: 100 }),
      ]);
      setPools(poolResult.items);
      setAccounts(accountResult.items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleCreate = async () => {
    const poolId = newPoolId.trim();
    if (!poolId) return;
    setCreating(true);
    try {
      await createPool({ poolId });
      props.notify(`已创建账号池 ${poolId}`);
      setNewPoolId('');
      setExpanded(poolId);
      await load();
    } catch (err) {
      props.notify((err as Error).message, 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (poolId: string) => {
    if (!window.confirm(`删除账号池 "${poolId}"？成员账号本身不会被删除。`)) return;
    try {
      await deletePool(poolId);
      props.notify(`已删除账号池 ${poolId}`, 'warning');
      await load();
    } catch (err) {
      props.notify((err as Error).message, 'error');
    }
  };

  const handlePrune = async () => {
    try {
      const { removed } = await pruneSessionAffinity();
      props.notify(`已清理 ${removed} 条过期会话绑定`);
      await load();
    } catch (err) {
      props.notify((err as Error).message, 'error');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">什么是账号池</h3>
            <p className="mt-1 text-sm text-slate-600">
              把一个对外暴露的 identity 映射到后台多个真实账号，提升可用总额度与并发能力。
              客户端只看到池名，实际由哪个账号承接由这里的策略决定；某个账号被限流会自动冷却并切换，请求不中断。
              加入或移出成员都是热操作，无需重启服务。
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[220px]">
              <label className="mb-1 block text-xs font-medium text-slate-600">新建池（这个名字就是客户端要用的 identity）</label>
              <Input value={newPoolId} onChange={(e) => setNewPoolId(e.target.value)} placeholder="team-alpha" />
            </div>
            <Button onClick={handleCreate} disabled={creating || !newPoolId.trim()}>
              {creating ? '创建中…' : '创建池'}
            </Button>
            <Button variant="secondary" onClick={handlePrune}>清理过期会话绑定</Button>
            <Button variant="secondary" onClick={() => void load()}>刷新</Button>
          </div>
        </div>
      </Card>

      {error ? <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      {loading ? <p className="text-sm text-slate-500">加载中…</p> : null}
      {!loading && pools.length === 0 ? (
        <Card><p className="text-sm text-slate-500">还没有账号池。在上面创建一个，然后把已接入的账号加进去。</p></Card>
      ) : null}

      {pools.map((pool) => (
        <PoolCard
          key={pool.poolId}
          pool={pool}
          accounts={accounts}
          expanded={expanded === pool.poolId}
          onToggle={() => setExpanded(expanded === pool.poolId ? undefined : pool.poolId)}
          onChanged={load}
          onDelete={() => handleDelete(pool.poolId)}
          notify={props.notify}
        />
      ))}
    </div>
  );
}

function PoolCard(props: {
  pool: PoolDto;
  accounts: ProxyAccountDto[];
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void>;
  onDelete: () => void;
  notify: Notify;
}) {
  const { pool } = props;
  const [addIdentity, setAddIdentity] = useState('');
  const [busy, setBusy] = useState(false);

  const memberIds = new Set(pool.members.map((m) => m.identity));
  const candidates = props.accounts.filter(
    (a) => !memberIds.has(a.identity) && a.identity !== pool.poolId,
  );

  const run = async (fn: () => Promise<unknown>, okMessage: string) => {
    setBusy(true);
    try {
      await fn();
      props.notify(okMessage);
      await props.onChanged();
    } catch (err) {
      props.notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button className="text-left" onClick={props.onToggle}>
            <span className="text-lg font-semibold text-slate-950">{pool.poolId}</span>
          </button>
          {pool.enabled
            ? <Badge tone="success">启用</Badge>
            : <Badge tone="warning">已停用（回落为普通身份）</Badge>}
          <Badge tone="info">{STRATEGY_LABEL[pool.strategy]}</Badge>
          <span className="text-sm text-slate-600">
            可用 <strong className="text-slate-900">{pool.activeMembers}</strong> / {pool.totalMembers} 个账号
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={props.onToggle}>{props.expanded ? '收起' : '展开'}</Button>
          <Button variant="danger" onClick={props.onDelete}>删除池</Button>
        </div>
      </div>

      {props.expanded ? (
        <div className="mt-4 flex flex-col gap-4 border-t border-slate-200 pt-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <NumberField
              label="会话绑定时长（秒）"
              hint="同一会话在此时间内固定用同一账号"
              value={pool.sessionTtlSeconds}
              onSave={(v) => run(() => updatePool(pool.poolId, { sessionTtlSeconds: v }), '已更新会话时长')}
              disabled={busy}
            />
            <NumberField
              label="冷却时长（秒）"
              hint="账号遇到 429 后暂停多久"
              value={pool.cooldownSeconds}
              onSave={(v) => run(() => updatePool(pool.poolId, { cooldownSeconds: v }), '已更新冷却时长')}
              disabled={busy}
            />
            <NumberField
              label="失败阈值"
              hint="连续失败几次后进入冷却（429 立即冷却，不受此限）"
              value={pool.failureThreshold}
              onSave={(v) => run(() => updatePool(pool.poolId, { failureThreshold: v }), '已更新失败阈值')}
              disabled={busy}
            />
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">选择策略</label>
              <select
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                value={pool.strategy}
                disabled={busy}
                onChange={(e) => void run(
                  () => updatePool(pool.poolId, { strategy: e.target.value as PoolStrategy }),
                  '已更新选择策略',
                )}
              >
                {(Object.keys(STRATEGY_LABEL) as PoolStrategy[]).map((s) => (
                  <option key={s} value={s}>{STRATEGY_LABEL[s]}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">{STRATEGY_HINT[pool.strategy]}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[240px] flex-1">
              <label className="mb-1 block text-xs font-medium text-slate-600">添加成员账号</label>
              <select
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                value={addIdentity}
                onChange={(e) => setAddIdentity(e.target.value)}
              >
                <option value="">选择一个已接入的账号…</option>
                {candidates.map((a) => (
                  <option key={a.identity} value={a.identity}>
                    {a.identity}{a.copilotOauthStatus === 'valid' ? '' : `（${a.copilotOauthStatus}）`}
                  </option>
                ))}
              </select>
            </div>
            <Button
              disabled={busy || !addIdentity}
              onClick={() => void run(
                () => addPoolMember(pool.poolId, addIdentity).then(() => setAddIdentity('')),
                `已把 ${addIdentity} 加入 ${pool.poolId}`,
              )}
            >
              加入池
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void run(
                () => updatePool(pool.poolId, { enabled: !pool.enabled }),
                pool.enabled ? '已停用该池' : '已启用该池',
              )}
            >
              {pool.enabled ? '停用池' : '启用池'}
            </Button>
          </div>

          <MembersTable
            members={pool.members}
            busy={busy}
            onResume={(identity) => run(
              () => resumePoolMember(pool.poolId, identity),
              `已解除 ${identity} 的冷却`,
            )}
            onRemove={(identity) => run(
              () => removePoolMember(pool.poolId, identity),
              `已从池中移除 ${identity}`,
            )}
          />

          <p className="text-xs text-slate-500">
            客户端用法：把 Virtual Key 的 <code className="rounded bg-slate-100 px-1">trusted_user_id</code> 设为
            <code className="rounded bg-slate-100 px-1"> {pool.poolId}</code>，请求即自动在池内分配。
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function MembersTable(props: {
  members: PoolMemberDto[];
  busy: boolean;
  onResume: (identity: string) => void;
  onRemove: (identity: string) => void;
}) {
  if (props.members.length === 0) {
    return <p className="text-sm text-slate-500">这个池还没有成员 —— 加入账号后才能承接流量。</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="py-2">账号</th>
            <th className="py-2">状态</th>
            <th className="py-2">权重</th>
            <th className="py-2">连续失败</th>
            <th className="py-2">冷却至</th>
            <th className="py-2">最近使用</th>
            <th className="py-2 text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          {props.members.map((m) => (
            <tr key={m.identity} className="border-b border-slate-100">
              <td className="py-2 font-medium text-slate-900">{m.identity}</td>
              <td className="py-2">
                {m.state === 'active' ? <Badge tone="success">可用</Badge>
                  : m.state === 'cooling'
                    ? (m.available ? <Badge tone="info">冷却已到期</Badge> : <Badge tone="warning">冷却中</Badge>)
                    : <Badge tone="warning">已停用</Badge>}
              </td>
              <td className="py-2">{m.weight}</td>
              <td className="py-2">{m.consecutiveFailures}</td>
              <td className="py-2 text-slate-600">{m.coolingUntil ? new Date(m.coolingUntil).toLocaleString() : '—'}</td>
              <td className="py-2 text-slate-600">{m.lastUsedAt ? new Date(m.lastUsedAt).toLocaleString() : '从未'}</td>
              <td className="py-2 text-right">
                <div className="flex justify-end gap-2">
                  {m.state !== 'active' ? (
                    <Button variant="secondary" disabled={props.busy} onClick={() => props.onResume(m.identity)}>
                      解除冷却
                    </Button>
                  ) : null}
                  <Button variant="danger" disabled={props.busy} onClick={() => props.onRemove(m.identity)}>
                    移出
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NumberField(props: {
  label: string;
  hint: string;
  value: number;
  disabled: boolean;
  onSave: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => setDraft(String(props.value)), [props.value]);
  const dirty = draft !== String(props.value);
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-600">{props.label}</label>
      <div className="flex gap-2">
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} />
        {dirty ? (
          <Button
            disabled={props.disabled || !Number.isFinite(Number(draft)) || Number(draft) <= 0}
            onClick={() => props.onSave(Math.trunc(Number(draft)))}
          >
            保存
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-slate-500">{props.hint}</p>
    </div>
  );
}
