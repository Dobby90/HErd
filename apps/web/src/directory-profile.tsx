import { useState } from 'react';
import { field, Modal } from './editor-fields.js';
import { apiRequest } from './project-api.js';
import type { DirectoryProfile } from './project-api.js';

export function DirectorySettings({ profile, csrf, onSave }: {
  profile: DirectoryProfile | null; csrf?: string | null; onSave(profile: DirectoryProfile | null): void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [status, setStatus] = useState('');

  async function save(values?: FormData) {
    setBusy(true);
    setProblem('');
    setStatus('');
    try {
      const result = await apiRequest<DirectoryProfile | undefined>('/me/directory', { method: 'PATCH', csrf, body: values
        ? { publicName: field(values, 'publicName'), alias: field(values, 'alias') }
        : { publicName: null, alias: null } });
      onSave(result ?? null);
      setStatus(result ? '프로젝트 소유자가 검색에서 내 프로필을 찾을 수 있습니다.' : '검색에서 내 프로필을 숨겼습니다.');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : '검색 프로필을 저장하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button type="button" className="quiet" onClick={() => { setProblem(''); setStatus(''); setOpen(true); }}>검색 프로필</button>
    {open && <Modal title="검색 프로필" close={() => { if (!busy) setOpen(false); }}>
      <p className="muted">프로젝트 소유자가 공개 프로필을 검색해 멤버로 추가할 수 있습니다.</p>
      <form className="management-section" onSubmit={event => { event.preventDefault(); void save(new FormData(event.currentTarget)); }}>
        <label>공개 이름<input name="publicName" key={profile?.publicName ?? ''} required maxLength={100} disabled={busy}
          defaultValue={profile?.publicName} /></label>
        <label>별칭<input name="alias" key={profile?.alias ?? ''} required minLength={3} maxLength={64}
          autoCapitalize="none" autoComplete="off" placeholder="영문·숫자로 시작하는 고유 별칭" disabled={busy} defaultValue={profile?.alias} /></label>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>{profile ? '공개 프로필 저장' : '검색에 공개'}</button>
          {profile && <button type="button" disabled={busy} onClick={() => void save()}>검색에서 숨기기</button>}
        </div>
      </form>
      {status && <p role="status">{status}</p>}
      {problem && <p role="alert">{problem}</p>}
    </Modal>}
  </>;
}
