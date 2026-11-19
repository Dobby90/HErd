import { useState } from 'react';
import { Modal } from './editor-fields.js';
import { Icon } from './editor-controls.js';
import { apiRequest } from './project-api.js';
import type { ProjectMember, ProjectRole } from './project-api.js';

const roles = { owner: 'owner · 관리', editor: 'editor · 편집', viewer: 'viewer · 조회' };

function RoleOptions() {
  return <>{Object.entries(roles).map(([role, text]) => <option key={role} value={role}>{text}</option>)}</>;
}

export function ShareCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return <details>
    <summary>내 공유 코드</summary>
    <div className="actions">
      <input aria-label="내 공유 코드" readOnly value={code} onFocus={event => event.currentTarget.select()} />
      <button type="button" onClick={() => void navigator.clipboard.writeText(code).then(() => setCopied(true), () => setCopied(false))}>코드 복사</button>
      {copied && <span role="status">복사했습니다.</span>}
    </div>
  </details>;
}

export function ProjectMembers({ projectId, userId, csrf, selfChanged }: {
  projectId: string; userId: string; csrf?: string | null; selfChanged(): void;
}) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [code, setCode] = useState('');
  const [candidate, setCandidate] = useState<{ displayName: string; shareCode: string }>();
  const [role, setRole] = useState<ProjectRole>('viewer');
  const [changes, setChanges] = useState<Record<string, ProjectRole>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const path = '/projects/' + projectId + '/members';

  async function reload() {
    setMembers(await apiRequest<ProjectMember[]>(path));
    setChanges({});
  }

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setProblem('');
    try { await run(); }
    catch (error) { setProblem(error instanceof Error ? error.message : '멤버 요청을 처리하지 못했습니다.'); }
    finally { setBusy(false); }
  }

  function close() {
    if (busy) return;
    setOpen(false);
    setCode('');
    setCandidate(undefined);
  }

  function change(member: ProjectMember, nextRole?: ProjectRole) {
    const removing = !nextRole;
    const action = removing ? `${member.displayName} 님의 프로젝트 권한을 회수하시겠습니까?`
      : `${member.displayName} 님의 역할을 ${roles[nextRole]}로 변경하시겠습니까?`;
    if (!window.confirm(action)) return;
    void act(async () => {
      await apiRequest(path + '/' + member.id, { method: removing ? 'DELETE' : 'PATCH', csrf, body: nextRole && { role: nextRole } });
      if (member.id === userId && nextRole !== 'owner') {
        setOpen(false);
        selfChanged();
      } else await reload();
    });
  }

  return <>
    <button type="button" onClick={() => { setOpen(true); void act(reload); }}><Icon name="users" />멤버 관리</button>
    {open && <Modal title="프로젝트 멤버 관리" close={close}>
      <form onSubmit={event => {
        event.preventDefault();
        const shareCode = code.trim().toLowerCase();
        void act(async () => {
          const found = await apiRequest<{ displayName: string }>(path + '/lookup', { method: 'POST', csrf, body: { shareCode } });
          setCandidate({ ...found, shareCode });
        });
      }}>
        <label>가입한 사용자의 공유 코드<input required value={code} disabled={busy} onChange={event => {
          setCode(event.target.value);
          setCandidate(undefined);
        }} /></label>
        <button type="submit" disabled={busy || !code.trim()}>사용자 확인</button>
      </form>
      {candidate && <div className="actions">
        <strong>{candidate.displayName}</strong>
        <label>추가할 역할<select value={role} disabled={busy} onChange={event => setRole(event.target.value as ProjectRole)}><RoleOptions /></select></label>
        <button type="button" disabled={busy} onClick={() => void act(async () => {
          await apiRequest(path, { method: 'POST', csrf, body: { shareCode: candidate.shareCode, role } });
          setCandidate(undefined);
          setCode('');
          await reload();
        })}>멤버 추가</button>
      </div>}
      {problem && <p role="alert">{problem}</p>}
      {busy && <p role="status">멤버 처리 중</p>}
      <ul className="version-list">{members.map(member => <li key={member.id}>
        <strong>{member.displayName}{member.id === userId && ' (나)'}</strong>
        <div className="actions">
          <label>역할<select aria-label={member.displayName + ' 역할'} value={changes[member.id] ?? member.role} disabled={busy}
            onChange={event => setChanges({ ...changes, [member.id]: event.target.value as ProjectRole })}><RoleOptions /></select></label>
          <button type="button" disabled={busy || !changes[member.id] || changes[member.id] === member.role}
            onClick={() => change(member, changes[member.id])}>역할 변경</button>
          <button type="button" className="danger" disabled={busy} onClick={() => change(member)}>권한 회수</button>
        </div>
      </li>)}</ul>
    </Modal>}
  </>;
}
