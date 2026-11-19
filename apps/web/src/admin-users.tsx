import { useEffect, useState } from 'react';
import { ActionMenu } from './editor-controls.js';
import { Modal } from './editor-fields.js';
import { apiRequest } from './project-api.js';

type Account = {
  id: string;
  displayName: string;
  username: string | null;
  alias: string | null;
  disabled: boolean;
  isAdmin: boolean;
  authMethod: 'password' | 'oidc' | 'development';
};
type Results = { users: Account[]; hasMore: boolean };
const authNames = { password: '자체 계정', oidc: 'OIDC', development: '개발 계정' };
const message = (error: unknown) => error instanceof Error ? error.message : '사용자 요청을 처리하지 못했습니다.';

function UserManagement({ csrf, close }: { csrf?: string | null; close(): void }) {
  const [input, setInput] = useState('');
  const [search, setSearch] = useState({ query: '', page: 1 });
  const [results, setResults] = useState<Results>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Account>();
  const [problem, setProblem] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ q: search.query, page: String(search.page) });
    void apiRequest<Results>('/admin/users?' + params).then(data => {
      if (active) setResults(data);
    }, error => {
      if (active) setProblem(message(error));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [search]);

  function load(query: string, page: number) {
    setSearch({ query, page });
    setResults(undefined);
    setProblem('');
    setStatus('');
    setLoading(true);
  }

  async function change(account: Account) {
    const disabled = !account.disabled;
    setBusy(true);
    setProblem('');
    setStatus('');
    try {
      await apiRequest('/admin/users/' + account.id, { method: 'PATCH', csrf, body: { disabled } });
      setResults(current => current && { ...current,
        users: current.users.map(user => user.id === account.id ? { ...user, disabled } : user) });
      setConfirmation(undefined);
      setStatus(`${account.displayName} 님의 계정을 ${disabled ? '비활성화' : '재활성화'}했습니다.`);
    } catch (error) {
      setProblem(message(error));
    } finally {
      setBusy(false);
    }
  }

  return <Modal title="사용자 관리" className="management-dialog" close={() => { if (!busy) close(); }}>
    <form className="management-search" onSubmit={event => { event.preventDefault(); load(input.trim(), 1); }}>
      <label>사용자 검색<input type="search" placeholder="이름, 아이디 또는 별칭" maxLength={100} value={input}
        disabled={busy || Boolean(confirmation)} onChange={event => setInput(event.target.value)} /></label>
      <button type="submit" disabled={busy || Boolean(confirmation)}>검색</button>
    </form>
    {problem && <p role="alert">{problem}</p>}
    {(loading || busy || status) && <p role="status">{loading ? '사용자 불러오는 중' : busy ? '계정 상태 저장 중' : status}</p>}
    {!loading && !results && <button type="button" onClick={() => load(search.query, search.page)}>다시 시도</button>}
    {results && (results.users.length ? <ul className="management-list" aria-label="사용자 목록">
      {results.users.map(account => <li key={account.id} className="management-row">
        <span className="management-name"><strong>{account.displayName}</strong>
          <small>{[authNames[account.authMethod], account.username, account.alias && '@' + account.alias, account.isAdmin && '관리자']
            .filter(Boolean).join(' · ')}</small>
        </span>
        <div className="management-row-actions">
          <span className="account-status">{account.disabled ? '비활성' : '활성'}</span>
          {!account.isAdmin && <button type="button" className={account.disabled ? '' : 'danger'} disabled={busy || Boolean(confirmation)}
            onClick={() => setConfirmation(account)}>{account.disabled ? '재활성화' : '비활성화'}</button>}
        </div>
      </li>)}
    </ul> : <p role="status">검색 결과가 없습니다.</p>)}
    {results && (search.page > 1 || results.hasMore) && <nav className="actions" aria-label="사용자 목록 페이지">
      <button type="button" disabled={search.page === 1 || Boolean(confirmation)}
        onClick={() => load(search.query, search.page - 1)}>이전</button>
      <span>{search.page} 페이지</span>
      <button type="button" disabled={!results.hasMore || Boolean(confirmation)}
        onClick={() => load(search.query, search.page + 1)}>다음</button>
    </nav>}
    {confirmation && <section className="management-section management-confirm" aria-label="계정 상태 변경 확인">
      <p>{confirmation.disabled ? `${confirmation.displayName} 님이 다시 로그인할 수 있게 됩니다.`
        : `${confirmation.displayName} 님의 기존 세션이 종료되고 새 로그인이 차단됩니다.`}</p>
      <div className="actions">
        <button autoFocus type="button" disabled={busy} onClick={() => setConfirmation(undefined)}>취소</button>
        <button type="button" className={confirmation.disabled ? 'primary' : 'danger'} disabled={busy}
          onClick={() => void change(confirmation)}>{confirmation.disabled ? '재활성화 확인' : '비활성화 확인'}</button>
      </div>
    </section>}
  </Modal>;
}

export function AdminUsers({ csrf }: { csrf?: string | null }) {
  const [open, setOpen] = useState(false);
  return <>
    <ActionMenu label="관리자" icon="settings">
      <button type="button" onClick={() => setOpen(true)}>사용자 관리</button>
    </ActionMenu>
    {open && <UserManagement csrf={csrf} close={() => setOpen(false)} />}
  </>;
}
