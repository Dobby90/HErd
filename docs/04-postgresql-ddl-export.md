# 4단계 — PostgreSQL DDL export

선행 조건: [3단계](./03-projects-and-persistence.md) 완료. [공통 아키텍처](./00-scope-and-architecture.md)의 SQL 계약과 1단계의 PostgreSQL 지원 명세를 따른다.

## 목표와 범위

저장된 ERD의 선택한 스키마 구조를 PostgreSQL 생성 SQL로 내보낸다. 결과는 새 테스트 DB에 적용할 수 있는 생성 스크립트다. 기존 운영 DB의 변경분 계산·DROP 재생성·직접 실행 기능은 구현하지 않는다.

생성기를 import보다 먼저 구현해 내부 모델과 SQL 표현의 기준을 확보한다. 파서·생성기는 모두 PostgreSQL adapter 안에 둔다.

## 초기 지원 범위

아래 항목은 이 단계의 구현 목표다. 인증 엔진 버전에서 실제 생성·실행 검증한 항목만 지원 명세에 완료로 표시한다.

| 대상 | 기본 범위 |
| --- | --- |
| namespace·이름 | 스키마 생성, namespace-qualified 식별자, 인용·예약어·한글·대소문자 |
| table·column | 컬럼 순서, 기본 PostgreSQL 타입, UUID·JSONB·배열, nullable, DEFAULT |
| 제약 | 이름 있는 PK·UNIQUE·CHECK·FK, 복합키, 자기·순환 참조, 참조 동작 |
| index | 일반·고유·복합 B-tree 인덱스. UNIQUE 제약의 backing index와 중복 생성하지 않음 |
| 설명 | 테이블·컬럼의 `COMMENT ON` |
| 자동 번호 | `GENERATED ... AS IDENTITY`, sequence의 타입·start/increment/min/max/cache/cycle·ownership·default 의존성 |
| 사용자 타입 | 같은 문서에서 정의한 ENUM과 컬럼 타입 참조 |

부분 인덱스·식 인덱스·GIN/GiST·domain·partition·generated column·view·trigger·function·권한·extension은 초기 완전 지원 대상이 아니다. 이를 담은 모델이 있으면 미지원 진단으로 export를 차단한다. 공통 타입이 표현 가능하다는 이유만으로 export 지원으로 표시하지 않는다.

DEFERRABLE·NOT VALID·MATCH·NULLS NOT DISTINCT 같은 세부 의미 옵션도 지원 명세에서 따로 판정한다. 미지원 옵션을 기본값으로 바꾸거나 옵션만 버리고 제약을 지원 처리하지 않는다.

## 구현 작업

### 1. 의미 검증과 생성 계획

- `validate`에서 구조 오류 외에 중복 물리명, 존재하지 않는 타입·sequence, 참조 키 유일성, FK 타입 호환, 지원하지 않는 옵션을 검사한다.
- 타입 파라미터·배열·타입 namespace는 descriptor에서 생성한다. `text` 같은 공통 타입으로 몰래 치환하지 않는다.
- DEFAULT·CHECK는 해당 표현식 문맥에서 AST로 검증한다. 저장 문자열에 임의 문장이 연결되어도 추가 최상위 SQL이 만들어지면 안 된다.
- 참조 분석이 불충분한 식을 가진 객체의 이름·컬럼이 바뀌었다면 미해결 진단이 없어질 때까지 생성하지 않는다.
- `CREATE SCHEMA → ENUM·SEQUENCE → TABLE → 추가 제약·FK → INDEX·ownership → COMMENT` 순서를 기본으로 생성 계획을 만든다. 세부 의존성이 있으면 그 관계를 우선한다.
- 순환 FK는 테이블을 먼저 만든 뒤 `ALTER TABLE ... ADD CONSTRAINT`로 출력한다.
- sequence default와 `OWNED BY`, IDENTITY가 암묵적으로 만드는 sequence를 구분해 중복 생성하지 않는다.

### 2. 이름·문자열·출력 정책

- 식별자 인용, 문자열 literal 이스케이프, 자료형·식 출력은 전용 함수로 처리한다. `sales.users`는 스키마와 테이블을 각각 인용한다.
- 동일 문서·옵션의 결과 순서를 결정적으로 유지한다. 불필요한 타임스탬프를 본문에 넣어 매번 diff가 생기지 않게 한다.
- 주석·DEFAULT의 따옴표, 줄바꿈, dollar-quoted 표현식을 fixture로 확인한다.
- 기본 export는 원래 물리명·타입·설명을 유지한다. 논리명을 물리명이나 COMMENT로 자동 덮어쓰지 않는다.
- 기존 객체 존재를 무시하는 옵션이나 자동 DROP을 기본으로 제공하지 않는다. 생성 대상 충돌은 사용자가 다운로드한 SQL을 적용할 때의 문제이며, 서비스가 DB를 조회하거나 변경하지 않는다.
- export 결과에 target·adapter 버전·원본 문서 revision과 진단을 연결한다.

### 3. 전체·부분 선택

- 기본은 catalog 전체다. 현재 뷰나 선택 테이블만 출력하는 경우는 명시적 옵션으로 제공한다.
- 선택한 테이블의 FK 대상, ENUM·sequence·namespace 의존성을 계산한다.
- 초기 정책은 필요한 참조 테이블을 재귀적으로 포함하고, 실제 추가될 객체 목록을 미리 보여주는 방식으로 한다. 순환 참조에서는 중복 없이 종료해야 한다.
- 사용자가 선택한 뷰의 숨김 상태와 실제 export 범위를 혼동하지 않게 한다. 뷰 밖에 있는 FK 대상도 필요하면 포함한다.
- 제약을 몰래 빼서 부분 export를 성공시키지 않는다. 의존성을 해결할 수 없으면 차단한다.

### 4. SQL 작업 API와 실행 격리

- `GET /api/sql/dialects`로 등록한 대상·버전·capability를 제공한다.
- `POST /api/projects/:projectId/sql/jobs`에 `kind: generate`, `erdId`, `revision`, 옵션, `mutationId`를 받아 작업을 생성한다.
- viewer 이상은 자신이 조회 가능한 문서의 SQL export를 실행할 수 있다. 소속·역할은 생성과 결과 조회 시 다시 확인한다.
- 작업 생성 시 revision을 확인해 문서 snapshot을 고정한다. 이미 바뀌었으면 409를 반환한다. 실행 중 새 저장이 발생해도 작업의 원본 revision은 바뀌지 않는다.
- `GET /api/sql/jobs/:jobId`로 상태·진단·결과를 조회하고 `DELETE /api/sql/jobs/:jobId`로 취소한다.
- 상태는 queued/running/succeeded/failed/cancelled다. API가 작업 메타데이터와 임시 결과를 관리하고 제한된 worker pool에서 SQL 코어를 실행한다. 별도 큐 서비스는 도입하지 않는다.
- 기본 실행 제한은 10초, 완료 결과 TTL은 10분, 사용자당 활성 작업 2개로 시작한다. 설정 가능하게 만들고 worker를 실제 종료할 수 있어야 한다.
- 프로세스 재시작 시 남은 running 작업을 실패로 정리하고 재요청할 수 있게 한다. 영구적으로 running인 작업을 남기지 않는다.
- 작업 소유자·프로젝트 권한을 확인하며 SQL 원문·결과를 로그에 남기지 않는다. TTL 후 결과를 제거한다.

### 5. 웹 통합

- export 전에 자동 저장을 완료하고 해당 revision으로 작업을 요청한다. 저장 실패·충돌이면 먼저 해결하게 한다.
- 대상 버전, 전체/선택 범위, 자동 포함 의존성, 생성 상태와 진단을 보여준다.
- SQL 미리보기·복사·UTF-8 `.sql` 다운로드를 제공한다. 오류가 있으면 다운로드를 활성화하지 않는다.
- viewer는 저장이 필요 없는 서버 최신 revision을 대상으로 출력한다.
- 작업 이후 문서가 수정되면 출력이 어느 revision인지 표시하고 다시 생성할 수 있게 한다.

## 검증

1. 통제된 ERD fixture로 SQL을 생성해 인증 대상 PostgreSQL의 빈 테스트 DB에서 실행한다. 사용자 업로드 SQL을 실행 검증용으로 사용하지 않는다.
2. DB catalog에서 타입·default·PK/FK/UNIQUE/CHECK·index·comment·enum·sequence의 의미를 확인한다.
3. 복합키·자기 참조·순환 FK·동명 다른 스키마·예약어·한글·따옴표를 확인한다.
4. IDENTITY와 sequence ownership이 중복·누락 없이 동작하는지 확인한다.
5. 부분 선택의 의존성 목록과 실제 실행 결과가 일치한다.
6. 미지원 속성·검토 필요 표현식·버전 불일치는 다운로드를 차단한다.
7. 시간 초과·취소·재시작·권한 없는 작업 조회를 통합 검증한다.

### 검증 결과

2026-11-18 Docker에서 Node.js 24.12.0, pnpm 10.11.0, PostgreSQL 17.12, Chromium 156.0.8078.79를 사용했다. 클린 설치, 빌드, 타입 검사, lint, 기본 테스트 40개, 통합 테스트 6개가 통과했다. 운영 빌드의 SQL worker도 별도로 실행했다.

| 기준 | 판정 | 확인 내용 |
| --- | --- | --- |
| 1. 생성 SQL 실행 | 통과 | 통제된 ERD의 전체·부분 SQL을 각각 비어 있는 PostgreSQL 17 DB에서 실행했다. 동일 입력의 SQL이 일치했다. [실행 검증](../tests/ddl-export.integration.test.ts) |
| 2. catalog 의미 | 통과 | `pg_attribute`, `pg_constraint`, `pg_index`, `pg_enum`, `pg_sequence`, 설명과 DEFAULT를 확인했다. 실제 삽입으로 배열·JSONB·UUID·ENUM·문자열 기본값을 확인했다. [실행 검증](../tests/ddl-export.integration.test.ts) |
| 3. 키·식별자 | 통과 | 복합 PK의 순서, 역순 FK 대응, 자기·순환 FK와 참조 동작, 동명 테이블의 서로 다른 스키마, 예약어·대소문자·한글·따옴표를 확인했다. [실행 검증](../tests/ddl-export.integration.test.ts) |
| 4. IDENTITY·sequence | 통과 | `ALWAYS`·`BY DEFAULT`의 내부 sequence와 명시적으로 소유된 sequence를 `pg_depend`와 catalog로 구분했다. 기존 인덱스 이름과 자동 sequence 후보 이름이 겹치는 fixture도 실행했다. [실행 검증](../tests/ddl-export.integration.test.ts) |
| 5. 부분 선택 | 통과 | 뷰 밖의 FK 대상, DEFAULT에서 발견한 sequence, ENUM, 스키마가 미리보기와 실제 SQL에 포함됐다. 무관한 테이블·시퀀스는 선택 범위에서 제외됐다. [실행 검증](../tests/ddl-export.integration.test.ts), [브라우저 검증](../tests/ddl-export-browser.integration.test.ts) |
| 6. 생성·다운로드 차단 | 통과 | 부분·식 인덱스, 미지원 옵션·타입, 식 이름 변경 검토, 버전 불일치, 식 문맥의 잘못된 입력에서 SQL을 반환하지 않았다. Chromium에서 실패의 진단과 다운로드 차단을 확인했다. [생성기 테스트](../tests/ddl-export.test.ts), [브라우저 검증](../tests/ddl-export-browser.integration.test.ts) |
| 7. SQL 작업 API | 통과 | 리비전 고정과 재요청, 작업 소유자·회원 제한, 활성 작업 한도, 실행 중 취소, 시간 초과, 재시작 복구, 결과 만료와 삭제를 확인했다. [작업 API 테스트](../tests/sql-jobs.integration.test.ts) |

## 완료 기준

- [x] 공통 UI가 PostgreSQL 생성 구현을 직접 호출하지 않고 SQL 서비스·registry를 사용한다.
- [x] 지원한 fixture의 생성 SQL이 인증 DB에서 실행되고 의미 검증을 통과한다.
- [x] 선택 export가 의존성을 보존한다.
- [x] 오류·미지원 기능이 SQL에서 조용히 사라지지 않는다.
- [x] 작업 상태·취소·TTL·revision 표시와 `.sql` 다운로드가 동작한다.
- [x] `docs/sql-support/postgresql.md`의 export 상태·제한을 갱신했다.

## 실행과 작업 설정

- 기존 서비스 DB에 `pnpm db:migrate`로 SQL 작업 마이그레이션을 적용한다. `GET /api/sql/dialects`는 등록 프로필과 capability를 반환한다. `POST /api/projects/:projectId/sql/jobs`의 `options`에서 `tableIds`, `includeComments`, `previewOnly`를 지정할 수 있다. `previewOnly` 성공 응답에는 의존성과 진단이 포함된다. [마이그레이션](../db/migrations/002-sql-jobs.sql), [작업 API](../apps/api/src/sql-jobs.ts)
- API 프로세스 하나가 PostgreSQL의 작업 상태를 관리하고 worker 동시 실행을 제한한다. 기본값은 실행 제한 10초, 완료 결과 보관 10분, 사용자당 활성 작업 2개, worker 2개다. `SQL_JOB_TIMEOUT_MS`, `SQL_JOB_TTL_MS`, `SQL_JOB_USER_LIMIT`, `SQL_JOB_WORKERS`로 조정한다. API 시작 시 남아 있는 `queued`·`running`은 재요청 가능한 실패 상태로 정리한다. [환경 예시](../.env.example), [worker 관리](../apps/api/src/sql-queue.ts)
- SQL 생성은 저장된 리비전의 문서를 읽는다. 사용 중인 DB에 대한 적용은 사용자가 다운로드한 SQL로 수행하며, 자동 실행 검증에는 프로젝트 밖의 격리된 테스트 DB와 저장소 fixture를 사용한다. [지원 범위](./sql-support/postgresql.md)

## 다음 단계와 개발 요청 예시

다음은 [5단계 DDL import](./05-postgresql-ddl-import.md)다.

> docs/README.md와 docs/00-scope-and-architecture.md를 읽고, docs/04-postgresql-ddl-export.md의 4단계를 구현해줘. 지원 범위의 생성 SQL을 격리한 PostgreSQL에서 실행하고 의미를 확인해줘.

PostgreSQL adapter `0.2.0`은 PostgreSQL 17 대상의 전체·부분 DDL 내보내기를 제공한다. [PostgreSQL 지원 상태](./sql-support/postgresql.md)
