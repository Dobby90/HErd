import { postgresqlMetadata } from '@erd/dialect-postgresql/ui';
import { erdDocumentSchema, validateDocumentStructure } from '@erd/model';
import { sampleDocument } from '@erd/test-fixtures';

export function SampleApp() {
  const parsed = erdDocumentSchema.safeParse(sampleDocument);
  if (!parsed.success) {
    return <main><h1>샘플 ERD</h1><p role="alert">샘플 문서 형식이 올바르지 않습니다.</p></main>;
  }
  const document = parsed.data;
  const diagnostics = validateDocumentStructure(document);
  const engine = postgresqlMetadata.profiles.find(profile => profile.version === document.target.engineVersion);
  const tables = new Map(document.catalog.tables.map(table => [table.id, table]));

  return (
    <main>
      <header>
        <h1>{document.name}</h1>
        <p>{postgresqlMetadata.name} {document.target.engineVersion}{engine?.status === 'candidate' ? ' · 검증 후보' : ''} · 읽기 전용</p>
        <p role="status">{diagnostics.length === 0 ? '구조 검증 통과' : '구조 오류 ' + diagnostics.length + '건'}</p>
        {diagnostics.length > 0 && (
          <ul>{diagnostics.map(({ code, objectId, message }, index) => <li key={index}>{code} ({objectId}) {message}</li>)}</ul>
        )}
      </header>
      <section aria-labelledby="tables">
        <h2 id="tables">테이블</h2>
        <dl className="table-list">
          {document.catalog.tables.map(table => (
            <div key={table.id}>
              <dt><code>{table.physicalName}</code><span>{table.logicalName}</span></dt>
              <dd>{table.description}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-labelledby="views">
        <h2 id="views">다이어그램</h2>
        <div className="view-list">
          {document.views.map(view => (
            <article key={view.id}>
              <h3>{view.name}</h3>
              <ul>{view.instances.map(instance => <li key={instance.id}><code>{tables.get(instance.tableId)?.physicalName ?? instance.tableId}</code></li>)}</ul>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
