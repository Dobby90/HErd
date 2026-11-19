import { useEffect, useState } from 'react';
import { Modal } from './editor-fields.js';
import { Icon } from './editor-controls.js';
import { ApiFailure, apiRequest } from './project-api.js';
import type { DirectoryProfile, ProjectMember, ProjectRole } from './project-api.js';

const roles = { owner: '소유자', editor: '편집자', viewer: '조회자' };
const message = (error: unknown) => error instanceof Error ? error.message : '멤버 요청을 처리하지 못했습니다.';

type Candidate = DirectoryProfile & { id: string };
type CandidateResults = { users: Candidate[]; hasMore: boolean };
type MemberChange = { member: ProjectMember; role?: ProjectRole };

function RoleOptions({ owner = true }: { owner?: boolean }) {
  return <>{owner && <option value="owner">{roles.owner}</option>}
    <option value="editor">{roles.editor}</option><option value="viewer">{roles.viewer}</option></>;
}

function AddMember({ path, busy, add }: { path: string; busy: boolean; add(user: Candidate, role: ProjectRole): void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CandidateResults>();
  const [selected, setSelected] = useState<Candidate>();
  const [role, setRole] = useState<ProjectRole>('viewer');
  const [searching, setSearching] = useState(false);
  const [problem, setProblem] = useState('');

  async function search() {
    setSearching(true);
    setSelected(undefined);
    setResults(undefined);
    setProblem('');
    try {
      setResults(await apiRequest<CandidateResults>(path + '/candidates?q=' + encodeURIComponent(query.trim())));
    } catch (error) {
      setProblem(message(error));
    } finally {
      setSearching(false);
    }
  }

  return <section className="management-section" aria-label="멤버 추가">
    <form className="management-search" onSubmit={event => { event.preventDefault(); void search(); }}>
      <label>초대할 사용자<input type="search" autoFocus placeholder="공개 이름 또는 별칭 (2자 이상)" value={query} maxLength={100}
        disabled={busy || searching} onChange={event => {
          setQuery(event.target.value);
          setResults(undefined);
          setSelected(undefined);
          setProblem('');
        }} /></label>
      <button type="submit" disabled={busy || searching || query.trim().length < 2}>사용자 검색</button>
    </form>
    {searching && <p role="status">사용자 검색 중</p>}
    {problem && <p role="alert">{problem}</p>}
    {results && (results.users.length ? <>
      <fieldset className="management-list candidate-list" disabled={busy}>
        <legend className="sr-only">검색된 사용자</legend>
        {results.users.map(user => <label key={user.id}>
          <input type="radio" name="candidate" checked={selected?.id === user.id} onChange={() => setSelected(user)} />
          <span className="management-name"><strong>{user.publicName}</strong><small>@{user.alias}</small></span>
        </label>)}
      </fieldset>
      {results.hasMore && <p className="muted">처음 20명을 표시합니다. 검색어를 구체적으로 입력해 보세요.</p>}
    </> : <p role="status">추가할 수 있는 사용자가 없습니다. 상대의 검색 프로필이 공개되어 있는지 확인하세요.</p>)}
    {selected && <form className="management-search" onSubmit={event => { event.preventDefault(); add(selected, role); }}>
      <label>추가할 역할<select value={role} disabled={busy} onChange={event => setRole(event.target.value as ProjectRole)}>
        <RoleOptions owner={false} />
      </select></label>
      <button type="submit" className="primary" disabled={busy}>프로젝트에 추가</button>
    </form>}
  </section>;
}

function MembersDialog({ path, userId, csrf, close, selfChanged }: {
  path: string; userId: string; csrf?: string | null; close(): void; selfChanged(): void;
}) {
  const [members, setMembers] = useState<ProjectMember[]>();
  const [loading, setLoading] = useState(true);
  const [revision, refresh] = useState(0);
  const [adding, setAdding] = useState(false);
  const [changes, setChanges] = useState<Record<string, ProjectRole | undefined>>({});
  const [confirmation, setConfirmation] = useState<MemberChange>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [status, setStatus] = useState('');
  const ownerCount = members?.filter(member => member.role === 'owner' && !member.disabled).length;

  useEffect(() => {
    let active = true;
    void apiRequest<ProjectMember[]>(path).then(result => {
      if (active) setMembers(result);
    }, error => {
      if (active) setProblem(message(error));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, revision]);

  function reload() {
    setLoading(true);
    refresh(value => value + 1);
  }

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setProblem('');
    setStatus('');
    try {
      await run();
    } catch (error) {
      setProblem(message(error));
      if (error instanceof ApiFailure && ['LAST_OWNER', 'ALREADY_A_MEMBER', 'MEMBER_NOT_FOUND'].includes(error.code)) {
        setConfirmation(undefined);
        reload();
      }
    } finally {
      setBusy(false);
    }
  }

  function change({ member, role }: MemberChange, confirmed = false) {
    if (!confirmed && (!role || role === 'owner' || member.role === 'owner')) {
      setConfirmation({ member, role });
      return;
    }
    void act(async () => {
      await apiRequest(path + '/' + member.id, role ? { method: 'PATCH', csrf, body: { role } } : { method: 'DELETE', csrf });
      if (member.id === userId && role !== 'owner') {
        close();
        selfChanged();
        return;
      }
      setConfirmation(undefined);
      setMembers(current => role ? current?.map(item => item.id === member.id ? { ...item, role } : item)
        : current?.filter(item => item.id !== member.id));
      setChanges(current => ({ ...current, [member.id]: undefined }));
      setStatus(role ? `${member.displayName} 님의 새 역할은 ${roles[role]}입니다.`
        : `${member.displayName} 님의 프로젝트 접근 권한을 회수했습니다.`);
    });
  }

  return <Modal title="프로젝트 멤버 관리" className="management-dialog members-dialog" close={() => { if (!busy) close(); }}>
    <div className="management-heading">
      <h3>현재 멤버{members && ` ${members.length}명`}</h3>
      <button type="button" className={adding ? '' : 'primary'} disabled={busy || !members} aria-expanded={adding}
        onClick={() => { setAdding(value => !value); setConfirmation(undefined); setProblem(''); }}>
        {adding ? '멤버 추가 취소' : '멤버 추가'}
      </button>
    </div>
    {problem && <p role="alert">{problem}</p>}
    {(loading || busy || status) && <p role="status">{loading ? '멤버 불러오는 중' : busy ? '변경사항 저장 중' : status}</p>}
    {!members && !loading && <button type="button" onClick={() => { setProblem(''); reload(); }}>다시 시도</button>}
    {adding ? <AddMember path={path} busy={busy || loading} add={(user, role) => void act(async () => {
      const added = await apiRequest<ProjectMember>(path, { method: 'POST', csrf, body: { userId: user.id, role } });
      setMembers(current => [...(current ?? []), added]);
      setAdding(false);
      setStatus(`${added.displayName} 님을 프로젝트에 추가했습니다.`);
    })} /> : members && <ul className="management-list" aria-label="현재 멤버">
      {members.map(member => {
        const role = changes[member.id] ?? member.role;
        const lastOwner = member.role === 'owner' && !member.disabled && ownerCount === 1;
        const disabled = busy || loading || Boolean(confirmation) || lastOwner;
        return <li key={member.id} className="management-row">
          <span className="management-name"><strong>{member.displayName}{member.id === userId && ' (나)'}</strong>
            <small>{[member.alias && '@' + member.alias, roles[member.role], member.disabled && '비활성'].filter(Boolean).join(' · ')}</small>
            {lastOwner && <small>마지막 활성 소유자</small>}
          </span>
          <div className="management-row-actions">
            <select aria-label={member.displayName + ' 역할'} value={role} disabled={disabled}
              onChange={event => setChanges(current => ({ ...current, [member.id]: event.target.value as ProjectRole }))}><RoleOptions /></select>
            <button type="button" disabled={disabled || role === member.role} onClick={() => change({ member, role })}>역할 저장</button>
            <button type="button" className="danger" disabled={disabled} onClick={() => change({ member })}>권한 회수</button>
          </div>
        </li>;
      })}
    </ul>}
    {confirmation && <section className="management-section management-confirm" aria-label="멤버 변경 확인">
      <p>{confirmation.role ? `${confirmation.member.displayName} 님에게 ${roles[confirmation.role]} 권한을 부여합니다.`
        : `${confirmation.member.displayName} 님은 이 프로젝트와 ERD에 접근할 수 없게 됩니다.`}</p>
      <div className="actions">
        <button autoFocus type="button" disabled={busy} onClick={() => setConfirmation(undefined)}>취소</button>
        <button type="button" className={confirmation.role ? 'primary' : 'danger'} disabled={busy || loading}
          onClick={() => change(confirmation, true)}>{confirmation.role ? '변경 확인' : '회수 확인'}</button>
      </div>
    </section>}
  </Modal>;
}

export function ProjectMembers({ projectId, userId, csrf, selfChanged }: {
  projectId: string; userId: string; csrf?: string | null; selfChanged(): void;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={event => { event.currentTarget.focus(); setOpen(true); }}><Icon name="users" />멤버 관리</button>
    {open && <MembersDialog path={'/projects/' + projectId + '/members'} userId={userId} csrf={csrf}
      close={() => setOpen(false)} selfChanged={selfChanged} />}
  </>;
}
