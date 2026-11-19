# 5단계 — PostgreSQL DDL import

선행 조건: [4단계](./04-postgresql-ddl-export.md) 완료. [공통 아키텍처](./00-scope-and-architecture.md)의 변환·손실 정책을 따른다.

## 목표와 범위

PostgreSQL SQL 텍스트 또는 `.sql` 파일을 분석하고, 변환 결과·미지원 항목을 확인한 후 ERD로 적용한다. 외부 도구의 `.erd`, `.exerd` 등 ERD 파일은 다루지 않는다. 기존 모델과의 자동 병합 및 SQL migration 이력 재생은 초기 범위가 아니다.

기본 입력은 테이블 중심의 생성 DDL과 인증한 엔진 버전의 plain text `pg_dump --schema-only` 결과다. 덤프 전체의 모든 객체를 지원한다고 표시하지 않고, 지원 명세에 맞춰 문장별 결과를 보고한다. custom/tar/directory 형식의 덤프는 받지 않는다.

## 입력과 적용 흐름

v0.3.0부터 편집기의 **가져오기 → DDL로 테이블 추가**를 지원한다. 새 테이블과 의존 객체를 추가하고 현재 뷰에 배치하며 기존 객체·ID·배치는 보존한다. 새 외래 키는 저장된 모델의 키를 참조할 수 있다. 이름 충돌이나 기존 객체 변경은 분석에서 차단한다.

1. 프로젝트에서 `DDL로 새 ERD 만들기` 또는 편집기에서 `DDL로 모델 교체`를 선택한다.
2. SQL 대상·엔진 버전·기본 namespace를 명시한다. 기존 문서 교체에서는 문서 target을 그대로 사용한다.
3. SQL을 붙여 넣거나 UTF-8 `.sql` 파일을 선택한다. 기본 최대 크기는 5 MiB다.
4. 비동기 분석 작업으로 지원 객체·미지원 구문·오류·이름 해석 결과를 보여준다.
5. 사용자가 적용 범위와 경고를 확인한다. 미지원 구문이 있으면 제외되는 항목과 그 의미를 개별 목록으로 확인한다.
6. 서버가 후보 모델을 검증하고 새 문서를 만들거나, 이전 버전을 남긴 뒤 기존 문서를 원자적으로 교체한다.

`Import`는 분석 중 현재 문서를 변경하지 않는다. 실패·취소·작업 만료 시 원래 모델을 유지한다. 손실 확인은 해당 분석 결과에만 유효하며 입력이 바뀌면 다시 받아야 한다.

## 구현 작업

### 1. 전처리와 PostgreSQL 파서

- 1단계에서 선택한 파서를 서버 worker에서 실행한다. 파서의 원본 AST는 PostgreSQL adapter 안에서만 사용한다.
- SQL을 정규식이나 단순 `;` 분리로 파싱하지 않는다. 문자열·주석·dollar quoting·인용 식별자 안의 구분자를 보존한다.
- pg_dump의 psql 메타명령은 SQL 문법과 구분한다. 인증한 dump의 `\restrict`/`\unrestrict` 등 비구조 제어문만 명시적 규칙으로 건너뛰고 기록한다.
- `\i`, `\include`, `\!`, `\copy` 등 외부 파일·명령 실행을 뜻하는 입력은 실행하지 않으며 차단 진단을 만든다.
- SET·소유권·권한 구문은 각각 처리 정책을 정한다. namespace 해석에 영향이 없는 세션 설정은 기록 후 무시할 수 있지만 구조 정보와 같은 완료 상태로 표시하지 않는다.
- `search_path`가 이름 해석에 영향을 주면 상태로 추적한다. 명시한 기본 namespace와 입력의 유효한 path를 사용하고, `$user`·모호한 참조·지원 못 하는 동적 설정은 추측하지 않고 오류로 보고한다.
- 전처리한 텍스트와 원문 offset 매핑을 유지해 오류 위치가 실제 파일의 행·열을 가리키게 한다.

### 2. AST → catalog 변환

- 4단계에서 생성하는 객체·옵션을 읽고 보존하는 것을 최소 지원 집합으로 삼는다.
- `CREATE SCHEMA`, ENUM용 `CREATE TYPE`, `CREATE SEQUENCE`, `CREATE TABLE`, 기본 `CREATE INDEX`, `COMMENT ON`을 처리한다.
- dump에서 뒤따르는 `ALTER TABLE ... ADD CONSTRAINT`, column DEFAULT·IDENTITY 설정, `ALTER SEQUENCE ... OWNED BY` 등 동일 지원 집합에 필요한 후속문을 처리한다.
- inline 제약과 별도 ALTER 제약을 하나의 모델 표현으로 정규화한다. constraint와 backing index를 중복 생성하지 않는다.
- 테이블·컬럼·타입·키를 먼저 수집하고 이름·참조를 해결하는 다중 pass를 사용한다. 앞에서 정의되지 않은 참조와 순환 FK를 지원한다.
- 인용하지 않은 이름의 case folding과 인용한 이름의 정확한 값을 구분한다. 서로 다른 스키마의 동명 테이블을 합치지 않는다.
- SERIAL은 단순 정수로 축소하지 않는다. sequence·default 의미를 가진 명시 모델로 정규화하고, IDENTITY와는 구별한다.
- DEFAULT·CHECK는 원문 의미와 dialect·버전을 유지하고 가능한 객체 참조를 추출한다. 안전한 이름 변경을 보장할 수 없는 식에는 보수적인 의존성 검토 정보를 남긴다.
- 초기에는 `ALTER TABLE ... ADD/DROP COLUMN` 등이 이어지는 임의 migration 스크립트를 완전 재생하지 않는다. 미지원 정책을 적용한다.

### 3. 진단과 부분 적용 정책

문장별 결과를 `converted`, `ignored-nonstructural`, `unsupported`, `error`로 구분하고 원문 범위·객체·이유를 연결한다.

- 문법 오류, 중복/모순 정의, 해결하지 못한 타입·키·객체 참조가 있으면 적용을 차단한다.
- 파서가 읽지 못한 문장을 건너뛰어도 뒤쪽 SQL 경계를 확실히 구별할 수 없는 경우 전체 분석을 실패로 처리한다.
- view·function·trigger·partition·extension 등 미지원 구문을 제외할 수 있더라도 누락 객체를 표시한다.
- 제외한 `CREATE EXTENSION`이 제공하는 타입·default 함수 등 남은 모델의 의존성을 해결하지 못하면 부분 적용도 차단한다. 존재를 추측해 성공시키지 않는다.
- 잘못 지원한 CHECK·partial index를 일반 제약·인덱스로 바꾸는 식의 의미 축소는 허용하지 않는다.
- 사용자가 미지원 항목을 확인하면 독립적으로 지원 가능한 부분만 적용할 수 있다. 빠진 항목을 후속 export가 복원해준다고 안내하지 않는다.
- 변환 요약은 생성될 객체 수, 버전, 기본 namespace, 손실 목록, 적용 가능 여부를 포함한다.

### 4. 분석·적용 API

- 4단계의 작업 API에 `kind: parse`, `target`, `defaultNamespace`, SQL 입력을 추가한다. 프로젝트 editor 이상만 사용할 수 있다.
- 분석 결과는 임시 작업 저장소에 후보 catalog와 진단을 보관한다. 원문·결과는 기본 10분 후 제거하며 로그에 SQL 본문을 기록하지 않는다.
- `POST /api/sql/jobs/:jobId/apply`에 적용 방식 `create`/`replace`, 요청 mutation ID, 대상 문서·base revision, 확인한 손실 목록의 fingerprint를 받는다.
- 추가 분석은 `append: { erdId, baseRevision, viewId }`로 대상과 뷰를 고정하고 서버 catalog를 사용한다. 결과는 추가할 객체만 반환한다. `mode: "append"` 적용은 같은 문서와 리비전에서만 실행하며 적용 전 스냅샷을 남긴다.
- 서버가 완료·미만료 작업인지, 작업 소유자인지, 현재도 프로젝트 쓰기 권한이 있는지 확인한다. 클라이언트가 보낸 분석 성공 여부를 신뢰하지 않는다.
- replace는 문서 target 일치·revision을 확인하고 이전 snapshot 생성과 새 문서 저장을 같은 트랜잭션에서 처리한다. 충돌 시 409이며 작업 결과는 TTL 내 다시 사용할 수 있다.
- create도 mutation ID를 이용해 응답 유실 후 재시도에서 문서를 중복 생성하지 않는다. 적용 성공 결과는 임시 분석 결과와 별개로 멱등성 보관 기간 동안 복구할 수 있어야 한다.
- ID는 적용 시 안정적으로 매핑한다. 동일 apply의 재시도에서 매번 새 ID를 만들지 않는다.

### 5. 레이아웃과 편집기 연결

- 새 모델에는 기본 뷰 하나를 만들고 모든 변환 테이블을 배치한다.
- 초기 레이아웃은 겹침 없는 결정적 grid를 기본으로 한다. 관계 중심 자동 배치는 6단계에서 고도화할 수 있다.
- 기존 모델 교체는 새 기본 뷰로 교체하는 것으로 한다. 기존 좌표·ID와 이름 기반으로 자동 병합하지 않는다. 이전 문서의 배치는 교체 전 이력에서 보존된다.
- replace 후 로컬 undo 이력과 임시 복구본을 새 revision에 맞춰 초기화하고, 서버 이력에서 되돌릴 수 있음을 안내한다.
- 분석 요청 취소·다른 문서 이동·후속 분석 실행 시 오래된 응답이 현재 편집 상태를 덮어쓰지 않게 한다.

## 검증

1. 4단계 지원 fixture마다 `모델 → SQL → 모델`을 정규화해 타입·키·식·설명·보조 객체를 비교한다. 생성된 내부 ID·좌표·서식 차이는 제외한다.
2. 통제된 실제 PostgreSQL 스키마의 schema-only dump를 가져와 모델을 비교한다. 인증 버전별 dump fixture를 보관한다.
3. 줄바꿈·주석·따옴표·세미콜론이 있는 DEFAULT·dollar quoting·한글 식별자의 파싱과 오류 위치를 확인한다.
4. 복합 FK·자기 참조·순환 FK·스키마 동명·ENUM·SERIAL·IDENTITY·sequence ownership을 확인한다.
5. 미지원·손실·모순·해결 못 한 참조를 구분하고 적용 차단 또는 확인이 실제로 동작하는지 확인한다.
6. 분석 중 취소·timeout·원본 문서 수정·권한 회수·작업 만료·apply 재시도에서 데이터 손실이나 중복 생성이 없다.
7. 사용자 SQL이 서비스 DB에서 실행되지 않는지 확인한다. 실행 검증은 저장소의 통제된 fixture만 사용한다.

### 검증 결과

2026-11-18 Docker에서 Node.js 24.12.0, pnpm 10.11.0, PostgreSQL 17.12와 Chromium 156.0.8078.79를 사용했다. 클린 설치, 빌드, 타입 검사, lint, 기본 테스트 43개, 통합 테스트 9개가 통과했다. 운영 빌드의 worker에서 가져오기 작업도 실행했다.

| 기준 | 판정 | 확인 내용 |
| --- | --- | --- |
| 1. 모델·SQL·모델 의미 비교 | 통과 | 4단계 전체·부분 fixture의 생성 SQL을 분석한 후 재생성했다. 내부 ID·배치와 문장 순서를 제외한 전체 DDL이 일치했다. [왕복 테스트](../tests/ddl-import.test.ts) |
| 2. 실제 스키마 덤프 | 통과 | PostgreSQL 17.12에서 채집한 fixture와 새 `pg_dump --schema-only`의 변환 결과가 일치했다. 재생성한 별도 DB도 타입·기본값·제약·설명·ENUM·시퀀스 catalog가 원본과 같았다. [덤프 fixture](../packages/test-fixtures/sql/postgresql-17-schema.sql), [덤프 검증](../tests/ddl-import.integration.test.ts) |
| 3. 원문 위치와 리터럴 | 통과 | 중첩 주석, 인용 식별자, UTF-8 BOM, 줄바꿈·따옴표·세미콜론이 포함된 리터럴을 검증했다. 문법 오류와 차단된 psql 명령이 원문 위치를 가리켰다. [전처리 테스트](../tests/ddl-import.test.ts) |
| 4. 제약·스키마·보조 객체 | 통과 | 복합·자기·순환 FK, 스키마가 다른 동명 테이블, `USING INDEX` 정규화, ENUM, SERIAL과 시퀀스 소유권, 이름과 옵션이 있는 IDENTITY를 확인했다. [왕복 테스트](../tests/ddl-import.test.ts), [덤프 검증](../tests/ddl-import.integration.test.ts) |
| 5. 손실·무시·오류 | 통과 | 지원 문장과 덤프 제어문, 제외된 view, 중복·미해결 의존성을 분리했다. 제외 항목의 확인이 없거나 다른 결과의 fingerprint를 보내면 적용을 차단했다. 입력 수정 후 이전 확인은 초기화됐다. [API 검증](../tests/sql-import-jobs.integration.test.ts), [브라우저 검증](../tests/ddl-import-browser.integration.test.ts) |
| 6. 작업 수명과 안전한 적용 | 통과 | 취소·시간 초과·권한 회수·만료된 분석의 적용을 차단했다. 동시 교체 중 한 건만 저장됐고 스냅샷은 한 건만 남았다. 응답 유실 후 같은 mutation은 분석 만료 뒤에도 중복 생성 없이 원래 성공 결과를 받았다. 브라우저에서 늦게 도착한 분석 응답과 리비전 충돌도 확인했다. [API 검증](../tests/sql-import-jobs.integration.test.ts), [브라우저 검증](../tests/ddl-import-browser.integration.test.ts) |
| 7. 사용자 SQL과 서비스 DB 격리 | 통과 | 분석과 적용에 전달한 식별 테이블이 서비스 DB에 실제 생성되지 않았다. SQL 실행 검증에는 저장소의 고정 fixture와 격리된 테스트 DB만 사용했다. [DB 격리 검증](../tests/sql-import-jobs.integration.test.ts) |

## 완료 기준

- [x] SQL 입력→분석→미리보기→적용 흐름이 동작한다.
- [x] 지원 범위의 의미 비교와 인증 버전 dump 검증을 통과한다.
- [x] 미지원·무시·오류가 분리되고 조용한 손실이 없다.
- [x] replace 전 이력·revision·멱등성이 원자적으로 처리된다.
- [x] 입력 크기·작업 시간·취소·TTL이 실제로 적용된다.
- [x] `docs/sql-support/postgresql.md`에 import 범위와 남은 제한을 갱신했다.

## 실행과 적용 설정

- `pnpm db:migrate`로 기존 서비스 DB에 가져오기 마이그레이션을 적용한다. 분석 요청은 `POST /api/projects/:projectId/sql/jobs`에 `kind: parse`, `target`, `defaultNamespace`, `sql`, `mutationId`를 보낸다. editor와 owner가 작업을 생성·조회·적용할 수 있다. 기본 제한은 5 MiB, 10,000문장, 실행 10초, 결과 보관 10분이다. 입력 바이트는 `SQL_JOB_MAX_INPUT_BYTES`로 설정하며 시간·보관·활성 작업 상한은 내보내기와 공유한다. [환경 예시](../.env.example), [작업 API](../apps/api/src/sql-jobs.ts)
- `POST /api/sql/jobs/:jobId/apply`에서 `mode: create`에는 `name`, `mode: replace`에는 `erdId`와 `baseRevision`을 사용한다. 두 방식에 `mutationId`가 필요하다. 제외 항목을 받아들이려면 해당 결과의 `lossFingerprint`를 보낸다. 성공 응답의 `{ erdId, revision, updatedAt }`은 별도 테이블에 24시간 보관한다. [적용 API](../apps/api/src/sql-import-apply.ts), [마이그레이션](../db/migrations/003-sql-import.sql)
- 교체는 원래 문서 ID와 제목을 유지하고 가져온 객체의 새 ID와 기본 뷰를 적용한다. 이전 모델과 배치는 `before-import` 스냅샷에 보존하고, 현재 편집 세션의 실행 취소 이력과 복구본을 새 리비전으로 초기화한다. 기본 뷰는 한 행에 테이블 네 개를 배치하고 컬럼 수를 기준으로 행 높이를 계산한다. [지원 범위](./sql-support/postgresql.md#postgresql-17-ddl-import)

## 다음 단계와 개발 요청 예시

다음은 [6단계 공유·이력·이미지](./06-sharing-history-and-images.md)다.

> docs/README.md와 docs/00-scope-and-architecture.md를 읽고, docs/05-postgresql-ddl-import.md의 5단계를 구현해줘. 외부 ERD 파일 호환은 추가하지 말고, 지원 DDL의 보존·진단·원자적 적용·멱등성을 검증해줘.

PostgreSQL adapter `0.3.0`은 UTF-8 생성 DDL과 PostgreSQL 17 plain schema-only 덤프의 테이블 중심 구조를 분석한다. [현재 지원 범위](./sql-support/postgresql.md)
