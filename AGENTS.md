# AGENTS.md

## 작업 환경

- 저장소 루트에서 Node.js 24.12.0과 pnpm 10.11.0을 사용한다. 설치 명령은 `pnpm install --frozen-lockfile`이다. 버전과 명령은 `.node-version`과 `package.json`에서 확인한다.
- `pnpm dev`는 Vite 웹(`127.0.0.1:5173`)과 Fastify API(`127.0.0.1:3001`)를 함께 시작한다. DB 없이 로컬 편집기를 확인할 수 있다. 서버 저장이 필요한 작업은 [README의 개발 환경 설정](README.md#개발-환경에서-서버-저장-사용)을 따른다.
- 새 환경변수나 사용자 흐름을 추가할 때 관련 사용법을 함께 갱신한다. 운영 설정은 [.env.example](.env.example)과 [릴리스와 운영](README.md#릴리스와-운영), 화면 흐름은 [편집기 사용법](README.md#편집기-사용법)에 기록한다.

## 코드 위치

| 작업 | 우선 확인할 곳 |
| --- | --- |
| 편집 화면과 캔버스 | `apps/web/src/editor.tsx`, `editor-canvas.tsx`, `canvas-edit.tsx`, `schema-edits.ts` |
| 프로젝트 화면과 서버 저장·복구 | `apps/web/src/workspace.tsx`, `project-api.ts`, `server-editor.ts`, `server-drafts.ts`, `recovery.ts` |
| API 라우트와 데이터 저장 | `apps/api/src/app.ts`, `auth.ts`, `projects.ts`, `project-members.ts`, `revisions.ts`, `revision-storage.ts`, `database.ts` |
| 문서 모델과 검증 | `packages/model/src/schema.ts`, `structure.ts`, `lifecycle.ts`, `history.ts` |
| SQL 계약과 PostgreSQL 처리 | `packages/sql-contract`, `packages/sql-service`, `packages/dialect-postgresql`, `apps/api/src/sql-registry.ts` |
| SQL 작업 실행과 적용 | `apps/api/src/sql-jobs.ts`, `sql-queue.ts`, `sql-worker.ts`, `sql-import-apply.ts` |

같은 행에서 파일명만 적은 경로는 첫 파일과 같은 디렉터리에 있다. 모듈별 역할은 [저장소 구성](README.md#저장소-구성)에서 확인한다.

## 변경 시 유지할 계약

- `@erd/model`을 UI·서버·SQL 파서와 독립적으로 유지한다. `ErdDocument`의 객체는 안정적인 ID로 참조한다. 뷰의 테이블 배치를 제거해도 스키마의 테이블 정의와 다른 뷰의 배치는 유지한다. 복합 키의 순서와 FK 컬럼 대응을 보존한다. 실제 FK는 제약 객체에서 도출하고 논리 관계는 별도로 저장한다.
- 문서 `formatVersion`, SQL 대상 `engineVersion`, 서버 `revision`을 독립적으로 관리한다. 문서 형식을 바꿀 때 이미 저장된 문서, 브라우저 복구본, 과거 스냅샷의 읽기 호환성을 확인한다.
- 프로젝트·문서 쓰기에서 인증, 프로젝트별 권한 검사, Origin·CSRF 검사를 유지한다. 문서 저장은 `baseRevision` 비교와 저장을 같은 트랜잭션에서 처리한다. 같은 `mutationId`와 요청으로 재시도하면 이전 성공 결과를 재사용한다. 충돌은 클라이언트에 전달해 최신본 확인이나 복제가 가능해야 한다. DDL 적용과 버전 복원은 기존 리비전과 이력 보존 경로를 사용한다.
- 공통 SQL 기능은 `@erd/sql-contract`와 `@erd/sql-service`에 두고, PostgreSQL 구문·타입·AST 처리는 dialect 패키지에 둔다. API의 레지스트리에서 어댑터를 등록한다. 웹에서 PostgreSQL 메타데이터가 필요하면 `@erd/dialect-postgresql/ui`를 사용하고 파서는 서버 측에 둔다.
- 사용자 DDL은 서버의 격리 워커에서 분석한다. SQL 실행 검증에는 격리한 테스트 DB와 fixture를 사용한다. 가져오기는 제외 항목을 진단하고 사용자가 확인한 뒤 적용한다. 내보내기는 의존성을 포함하며 선택 범위의 의미를 지원할 수 없으면 진단과 함께 생성을 차단한다. 지원 범위가 바뀌면 [PostgreSQL DDL 지원 범위](README.md#postgresql-ddl-지원-범위)와 관련 검증을 갱신한다.
- 서비스 스키마 변경은 `db/migrations`에 다음 세 자리 순번과 소문자·하이픈 이름으로 SQL 파일을 추가한다. 적용된 파일은 이름과 체크섬으로 검증되므로 그대로 유지한다. 서비스 DB 마이그레이션은 설계 문서의 DDL 생성과 별개다.

## 검증

- `pnpm typecheck`와 `pnpm lint`로 타입과 소스를 검사한다. `pnpm test`는 모델·SQL 단위 테스트와 Chromium 편집기 시나리오를 포함한다.
- 저장·권한·동시성 또는 DDL 동작을 바꾸면 `pnpm test:integration`을 실행한다. 테스트는 `tests/support/postgres.ts`에서 임시 PostgreSQL 17 클러스터를 생성한다. 공통 입력은 `packages/test-fixtures`를 재사용한다. SQL 결과는 정규화한 모델과 실제 PostgreSQL catalog의 의미로 비교한다.
- 운영 빌드나 배포 동작을 바꾸면 `pnpm build` 후 `pnpm test:release`를 실행한다. Compose 패키지 검증은 `sh scripts/release-compose.sh`를 사용한다.
- 브라우저 실행 파일은 `CHROMIUM_PATH`로 지정할 수 있다. PostgreSQL과 Chromium을 함께 쓰는 검증은 `Dockerfile`의 `verify` 대상과 [CI 워크플로](.github/workflows/verify.yml)를 참고한다.
