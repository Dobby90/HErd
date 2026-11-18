# 1단계 — 개발 기반과 도메인 모델

선행 문서: [구현 순서](./README.md), [공통 아키텍처](./00-scope-and-architecture.md)

## 목표와 범위

TypeScript 기반 웹·API 개발 환경, ERD 원본 모델, SQL dialect 계약을 만든다. PostgreSQL 파서의 실제 동작도 작은 PoC로 확인해 후속 DDL 구현의 불확실성을 줄인다. 이 단계에서 완성된 ERD 편집기·로그인·DDL 입출력 UI를 만들지는 않는다.

진입 조건: 기존 코드와 AGENTS.md를 확인한다. 빈 저장소라면 공통 문서의 디렉터리 구조로 시작한다.

## 구현 작업

### 1. 실행 환경과 패키지 경계

- pnpm workspace와 TypeScript strict 설정을 만든다. 검증한 Node.js LTS·pnpm 버전을 고정한다.
- `apps/web`에 React + Vite, `apps/api`에 Fastify를 구성한다.
- 공통 문서의 `model`, `sql-contract`, `sql-service`, `dialect-postgresql`, `test-fixtures`를 만든다.
- 개발 시 웹에서 `/api`를 API로 프록시한다. 운영도 동일 origin을 기본으로 하며 불필요하게 CORS를 개방하지 않는다.
- API에 `GET /api/health`를 만든다. DB 연결이 아직 없어도 liveness와 readiness를 나중에 분리할 구조를 둔다.
- 루트에 `pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`를 제공한다. 외부 DB가 필요한 테스트는 별도 명령으로 둔다.
- 루트 README와 `.env.example`에 실행 방법을 적는다. 비밀값은 예시에 넣지 않는다.

### 2. ERD 모델과 문서 검증

- 공통 문서의 `ErdDocument` 구조를 구체 TypeScript 타입과 런타임 스키마로 정의한다.
- namespace·table·column·constraint·index·enum·sequence를 ID로 참조한다. 컬럼 순서와 키 순서를 보존한다.
- constraint는 PK·UNIQUE·FK·CHECK의 구분된 타입으로 만든다. 인덱스의 키는 컬럼 참조와 표현식을 구분할 수 있어야 한다.
- `views`는 테이블 ID를 가리키며 좌표·크기·컬럼 표시·그룹·메모를 가진다. 하나의 뷰에 같은 테이블을 중복 배치하는 기능은 초기에는 제한해도 된다.
- 논리 관계는 FK와 다른 객체다. 실제 SQL에는 FK 제약만 반영한다.
- `validateDocumentStructure`와 dialect 의미 검증을 분리한다. 내부 참조 오류와 export 불가 상태를 다르게 표현한다.
- 모델 생성·변경 명령의 입력과 결과를 정의한다. 명령은 문서 변경·진단·undo 정보를 한 단위로 반환한다.
- 알려지지 않은 dialect 확장 데이터는 임의 삭제하지 않는다. 보존은 가능해도 의미를 검증하지 못하면 export를 차단한다.
- `formatVersion: 1` 직렬화·역직렬화 경로를 만들고, 향후 `vN → vN+1` 순차 마이그레이션 registry를 둔다. 아직 없는 버전의 가짜 변환은 만들지 않는다.
- 미래 버전 문서를 읽었을 때 자동 하향 저장하지 않고 명시적 오류를 반환한다.

### 3. SQL 계약과 registry

- 공통 문서의 `SqlDialect` 요청·응답 타입, 진단 코드, capability 상태를 구체화한다.
- UI에서 필요한 dialect 메타데이터·타입 목록과 서버 파서 entry point를 분리한다.
- registry를 통한 조회와 `sql-service` 작업 조율 경로를 만든다. 미등록 dialect·미지원 엔진 버전의 실패 결과를 정의한다.
- PostgreSQL adapter를 등록한다. 아직 구현 전인 import/export는 `not-implemented`로 표시한다.
- 공통 도메인과 SQL 조율 계층에 PostgreSQL 이름·인용 규칙·파서 AST 의존성이 없는지 확인한다.

### 4. PostgreSQL 파서 PoC와 지원 명세

- `libpg_query` 계열의 Node.js 바인딩을 우선 검토한다. 설치·호환성·라이선스·AST 버전·worker 실행을 실제 확인한다.
- PostgreSQL 17·18 후보 중 파서와 실제 DB 검증이 가능한 메이저 버전을 첫 인증 대상으로 고정한다. 한 버전만 인증해도 되며 근거를 기록한다.
- 표준 타입, JSONB·배열·UUID, 식별자 인용, 복합키, FK, CHECK, DEFAULT 표현식, ENUM·SEQUENCE·IDENTITY의 AST를 조사한다.
- 통제된 샘플 스키마의 `pg_dump --schema-only` 결과를 입력해 SQL 외 메타명령과 보조문 처리 필요성을 기록한다. PoC는 사용자 업로드나 DB 실행 API를 만들지 않는다.
- 필요하면 파서 교체가 adapter 내부에서 끝나는지 확인한다. AST를 공통 모델로 노출해 PoC를 쉽게 끝내지 않는다.
- 이 단계의 결과로 `docs/sql-support/postgresql.md`를 작성한다. 기능별 model/edit/import/export 지원 상태, 인증 엔진·파서 버전, 미지원 처리 정책을 적는다. 계획과 구현 완료 상태를 구분한다.

### 5. 샘플 화면과 개발 데이터

- `users`, `orders`, `order_items`, `products`의 고정 샘플 문서를 제공한다. 이름·복합 제약·설명·뷰 두 개를 포함한다.
- 웹에서 샘플 문서를 로드하고 검증 결과와 테이블 목록을 볼 수 있게 한다. 편집 기능은 다음 단계다.
- 샘플은 개발용이며 실제 사용자 데이터처럼 자동 저장하거나 운영 프로젝트로 배포하지 않는다.

## 산출물

- 실행 가능한 workspace와 개발 README.
- `packages/model`의 타입·런타임 검증·직렬화·명령 계약.
- SQL 계약·registry·서버/웹 분리 entry point.
- PostgreSQL 파서 PoC, fixture, `docs/sql-support/postgresql.md`.
- 선택한 런타임·파서·인증 엔진 버전과 중요한 결정의 기록. 필요하면 `docs/decisions/`에 짧게 남긴다.

## 검증

1. 깨끗한 설치 후 개발 서버·빌드·타입 검사·lint가 동작한다.
2. 샘플 직렬화 후 다시 읽어 ID·컬럼 순서·제약·뷰 정보가 유지된다.
3. 중복 ID, 존재하지 않는 컬럼 참조, 잘못된 복합 FK 대응이 구조 오류로 탐지된다.
4. 같은 테이블을 두 뷰에서 참조해도 테이블 정의가 복제되지 않는다.
5. 파서 AST의 PostgreSQL 종속 타입을 앱이나 `model`이 import하지 않는다.
6. 미등록 dialect와 미인증 버전이 성공으로 처리되지 않는다.
7. PoC 결과가 문서의 지원 상태와 일치한다. 파싱만 검증한 기능을 import/export 완료로 표시하지 않는다.

### 검증 결과

2026-11-18에 `62ea2ab` 기준 작업 트리를 Docker에서 재검증했다. Node.js 24.12.0, pnpm 10.11.0, PostgreSQL 17.12를 사용했다.

| 기준 | 판정 | 확인 내용 |
| --- | --- | --- |
| 1. 클린 설치·개발 서버·빌드 | 통과 | `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`가 성공했다. 스모크 테스트로 웹과 API 기동, `/api/health` 프록시와 정상 종료를 확인했다. [스모크 테스트](../tests/workspace-smoke.test.ts) |
| 2. 직렬화 왕복 | 통과 | ID, 컬럼·키 순서, 제약, 뷰, 알 수 없는 확장 데이터가 유지됐다. 미래 형식 버전은 명시적으로 거부했다. [문서 수명주기 테스트](../tests/document-lifecycle.test.ts) |
| 3. 구조 오류 감지 | 통과 | 중복 ID, 잘못된 컬럼 참조, 복합 FK의 잘못된 컬럼 대응을 탐지했다. [모델 테스트](../tests/erd-model.test.ts) |
| 4. 두 뷰에서 정의 공유 | 통과 | 같은 테이블 ID를 두 뷰에서 참조하며 정의는 catalog에 한 번만 존재했다. [모델 테스트](../tests/erd-model.test.ts) |
| 5. PostgreSQL 파서 경계 | 통과 | 웹 번들에는 UI 메타데이터가 포함됐다. 파서와 서버 모듈은 웹 의존 그래프에서 제외됐고, 공통 패키지는 파서에 의존하지 않았다. 원본 AST는 파서 워커 내부에 한정했다. [스모크 테스트](../tests/workspace-smoke.test.ts), [파서 entry point](../packages/dialect-postgresql/src/parser.ts) |
| 6. 등록·인증 검사 | 통과 | 미등록 dialect와 미인증 엔진 버전에서 SQL 작업을 진단과 함께 차단했다. [SQL 서비스 테스트](../tests/sql-service.test.ts) |
| 7. PoC와 지원 명세 | 통과 | PostgreSQL 17 워커 파싱, 격리 DB의 fixture 실행과 실제 스키마 덤프 분석을 확인했다. 이 단계에서 정식 DDL import/export는 `not-implemented`였다. [PostgreSQL 지원 상태](./sql-support/postgresql.md) |

## 완료 기준

- [x] 저장소를 새로 받은 개발자가 README로 웹·API를 실행할 수 있다.
- [x] 문서·SQL 계약과 패키지 의존 경계가 구현되어 있다.
- [x] 모델 참조 무결성과 직렬화 검증이 통과한다.
- [x] PostgreSQL 최초 인증 목표와 파서 버전이 근거와 함께 고정되어 있다.
- [x] 후속 단계에서 구현할 기능과 현재 지원 상태가 명확히 구분된다.

## 다음 단계와 개발 요청 예시

다음은 [2단계 편집기](./02-erd-editor.md)다.

> docs/README.md와 docs/00-scope-and-architecture.md를 읽고, docs/01-foundation-and-domain.md에 따라 1단계를 구현해줘. 명시된 검증을 실행하고 실제 완료한 항목과 남은 제약을 기록해줘.

pnpm 워크스페이스, ERD v1 모델, SQL registry, 샘플 웹·API와 PostgreSQL 17 파서 PoC를 구현했다. 호스트 의존성 준비에서 lockfile을 생성했다. 호스트 검증 `step-72`에서 개발 서버, 빌드, 타입 검사, lint, 모델·SQL 단위 테스트와 PostgreSQL 통합 테스트가 통과했다. 워커와 실제 DB·덤프 결과를 근거로 PostgreSQL 17을 최초 인증 대상으로 고정했다. 인증 근거와 기능 상태는 [PostgreSQL 지원 상태](./sql-support/postgresql.md)에 기록했다.
