# PostgreSQL 지원 상태

첫 인증 엔진은 PostgreSQL 17입니다. 격리 환경은 `postgres:17-bookworm`, Node 24.12.0, pnpm 10.11.0을 사용합니다. 호스트 의존성 준비에서 `pgsql-parser@17.9.9`와 그 WebAssembly 파서 의존성 `libpg-query@17.7.3`의 설치와 lockfile 생성을 확인했습니다. 파서 선택 기준은 PostgreSQL 서버 파서 계열의 AST를 Node 워커에서 실행할 수 있고 별도 네이티브 빌드가 필요하지 않다는 점입니다. 설치된 두 패키지의 `package.json`에 표기된 라이선스는 MIT입니다.

호스트 검증 `step-72`에서 PostgreSQL 17 AST, 워커 종료, 격리된 PostgreSQL 17의 서버 버전과 fixture 실행, 실제 스키마 덤프 분석을 확인했습니다. 검증 환경의 기동 로그에는 PostgreSQL 17.12가 기록됐으며, 통합 테스트는 `server_version_num`으로 메이저 버전 17을 확인합니다. 이 결과를 근거로 메이저 버전 17을 인증 프로필로 고정했습니다.

| 기능 | 모델 | 편집 UI | DDL import | DDL export |
| --- | --- | --- | --- | --- |
| Namespace, 테이블, 컬럼 | 지원 | 생성·이름·설명·소속·컬럼 순서 편집 | `not-implemented` (5단계 예정) | 스키마 생성, 완전 수식된 이름, 컬럼 순서와 NULL 정책, 물리 객체 설명 |
| 내장 타입, JSONB, 배열, UUID, 인용 식별자 | 타입·식별자 기록 | 등록 타입·인수·배열 차원과 물리명 편집 | `not-implemented` (5단계 예정) | 등록된 PostgreSQL 17 내장 타입·인수·배열과 이스케이프된 UTF-8 식별자 |
| PK, UNIQUE, FK, CHECK, DEFAULT | 지원 | 순서 있는 키·FK 대응 및 참조 동작, CHECK·DEFAULT 식 편집 | `not-implemented` (5단계 예정) | 이름 있는 제약, 복합키, 자기·순환 참조, FK 동작, 지원하는 DEFAULT·CHECK 식 |
| 일반·고유·복합 B-tree 인덱스 | 지원 | 컬럼 키와 순서 편집 | `not-implemented` (5단계 예정) | 지원. 제약이 생성하는 동일 backing index는 한 번만 생성 |
| 부분·식 인덱스 | 지원 | 식 키와 조건 편집 | `not-implemented` (5단계 예정) | `unsupported` |
| ENUM·SEQUENCE·IDENTITY | 지원 | 기존 데이터 보존 | `not-implemented` (5단계 예정) | 문서 내 ENUM, 시퀀스 타입·범위·증가량·시작값·캐시·순환·소유권, `ALWAYS`·`BY DEFAULT` IDENTITY |

2026-11-18에 `62ea2ab` 기준 작업 트리의 PostgreSQL 17.12 통합 테스트가 통과했습니다. 정수 자식에서 NUMERIC 부모로 향하는 FK의 허용과 반대 방향의 거부, 날짜·시간 타입 간 FK 허용을 실제 DB에서 확인했습니다. UI와 서버 adapter는 동일한 PostgreSQL 의미 검증을 사용합니다. 빈 이름, 명명 범위 내 중복과 참조 불가 후보키를 객체별로 표시합니다. [통합 테스트](../../tests/postgresql.integration.test.ts)

## PostgreSQL 17 DDL export

- 생성 대상은 표준 `public` 스키마가 있는 새 PostgreSQL 17 DB입니다. 생성기는 다른 모델 스키마를 명시적으로 만들고 테이블·타입·시퀀스 이름을 각각 인용합니다. 물리명과 설명을 사용하며 선택 옵션으로 설명을 생략할 수 있습니다. [SQL 생성기](../../packages/dialect-postgresql/src/export.ts)
- 내장 타입은 `smallint`, `integer`, `bigint`, `numeric`, `boolean`, `text`, `varchar`, `date`, `timestamp`, `timestamptz`, `uuid`, `jsonb`, `bytea` 및 등록된 별칭입니다. 지원한 타입의 인수와 배열 차원은 descriptor에서 생성합니다. 문서의 ENUM은 스키마로 수식합니다. [타입 메타데이터](../../packages/dialect-postgresql/src/ui.ts)
- DEFAULT·CHECK의 리터럴, 캐스트, 배열, 지원 연산자와 내장 함수는 AST를 검증한 뒤 재구성합니다. CHECK의 컬럼 참조는 자기 테이블로 제한합니다. DEFAULT의 `nextval`은 문자열로 지목한 문서 내 시퀀스를 찾고 선택 의존성에 포함합니다. 시퀀스 이름에 스키마가 생략되면 컬럼 소속 스키마에서 찾습니다. 사용자 정의 함수, 서브쿼리, 검토 필요로 표시된 식은 차단합니다. [식 검증](../../packages/dialect-postgresql/src/expressions.ts)
- DEFERRABLE, NOT VALID, 별도 MATCH 옵션, NULLS NOT DISTINCT, 부분·식 인덱스, GIN·GiST, domain, partition, generated column, view, trigger, function, 권한, extension은 이 릴리스의 생성 범위 밖입니다. 버전이 명시된 확장 데이터는 저장할 수 있으며 이해할 수 없는 속성이 선택에 포함되면 진단하고 내보내기를 차단합니다. [지원 범위 테스트](../../tests/ddl-export.test.ts)
- 전체·부분 fixture를 PostgreSQL 17.12에서 적용해 catalog와 삽입 동작을 검증했습니다. SQL 작업에는 adapter `0.2.0`, 대상 엔진, 원본 리비전이 함께 기록됩니다. [실행 검증](../../tests/ddl-export.integration.test.ts), [작업 검증](../../tests/sql-jobs.integration.test.ts)

## PoC 검증

- `tests/postgresql-parser.test.ts`의 기존 워커 검증은 인용 이름, 배열, 복합키 순서, FK 대응, 타입·제약 AST와 워커 종료를 확인했습니다. 워커 요약과 회귀 검사에는 `gen_random_uuid()` 호출, `nextval`의 스키마 한정 문자열 인수, JSONB와 빈 배열의 타입 캐스트, `"Line" > 0` CHECK의 연산자와 피연산자를 추가했습니다.
- `tests/postgresql.integration.test.ts`는 같은 fixture를 임시 DB에서 실행해 테이블 3개, FK 1개, 시퀀스 2개, IDENTITY 컬럼 1개와 JSONB·UUID·배열 컬럼을 확인했습니다. 실제 `pg_dump --schema-only`에 포함된 `\restrict`, `\unrestrict`는 SQL 파서에서 문법 오류를 일으켰고 해당 줄을 제외한 SQL은 파싱됐습니다. 덤프에는 `SET`, `ALTER TABLE`, enum·시퀀스·인덱스 생성문도 있었습니다. 향후 덤프 import에서는 메타명령을 분류하고 보조문을 문장별로 처리해야 합니다.
- 서버 전용 `@erd/dialect-postgresql/parser`는 워커가 만든 검사 요약을 반환합니다. 원본 AST는 워커 내부에서 처리합니다. UI의 `@erd/dialect-postgresql/ui`는 메타데이터와 타입 목록을 제공합니다. 가져오기 중 미지원 문장과 변환 손실의 진단은 5단계에서 다룹니다.
