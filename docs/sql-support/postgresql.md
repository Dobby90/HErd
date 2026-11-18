# PostgreSQL 지원 상태

인증 엔진은 PostgreSQL 17이며 릴리스 검증과 Compose는 `postgres:17.12-bookworm`의 고정 이미지 digest와 실제 버전 `170012`를 사용합니다. PostgreSQL adapter `0.3.0`은 `pgsql-parser@17.9.9`와 `libpg-query@17.7.3`의 WASM AST를 사용합니다. 두 패키지의 라이선스는 MIT입니다. [고정 이미지](../../Dockerfile), [의존성 lockfile](../../pnpm-lock.yaml)

격리한 PostgreSQL DB에서 생성 SQL을 실행하고 catalog·입력 의미와 실제 schema-only dump를 비교했습니다. 사용자 SQL 분석·생성은 제한된 자식 프로세스에서 실행합니다. [SQL 검증 결과](../release-validation.md#검사-결과)

| 기능 | 모델 | 편집 UI | DDL import | DDL export |
| --- | --- | --- | --- | --- |
| Namespace, 테이블, 컬럼 | 지원 | 생성·이름·설명·소속·컬럼 순서 편집 | 스키마·일반 테이블·컬럼·COMMENT, 고정 `search_path` | 스키마 생성, 완전 수식된 이름, 컬럼 순서와 NULL 정책, 물리 객체 설명 |
| 내장 타입, JSONB, 배열, UUID, 인용 식별자 | 타입·식별자 기록 | 등록 타입·인수·배열 차원과 물리명 편집 | 등록 내장 타입·인수·배열과 인용 이름 | 등록된 PostgreSQL 17 내장 타입·인수·배열과 이스케이프된 UTF-8 식별자 |
| PK, UNIQUE, FK, CHECK, DEFAULT | 지원 | 순서 있는 키·FK 대응 및 참조 동작, CHECK·DEFAULT 식 편집 | 지원 집합의 인라인·ALTER 제약과 식, 복합·자기·순환 FK | 이름 있는 제약, 복합키, 자기·순환 참조, FK 동작, 지원하는 DEFAULT·CHECK 식 |
| 일반·고유·복합 B-tree 인덱스 | 지원 | 컬럼 키와 순서 편집 | 기본 컬럼 키 인덱스와 `USING INDEX`의 제약 정규화 | 지원. 제약이 생성하는 동일 backing index는 한 번만 생성 |
| 부분·식 인덱스 | 지원 | 식 키와 조건 편집 | `unsupported` · 제외 진단 | `unsupported` |
| ENUM·SEQUENCE·SERIAL·IDENTITY | 지원 | 기존 데이터 보존 | ENUM, sequence 옵션·OWNED BY, SERIAL 정규화, IDENTITY 모드·시퀀스 옵션 | 문서 내 ENUM, 명시 시퀀스 옵션·소유권, `ALWAYS`·`BY DEFAULT` IDENTITY와 내부 시퀀스 옵션 |

2026-11-18에 `62ea2ab` 기준 작업 트리의 PostgreSQL 17.12 통합 테스트가 통과했습니다. 정수 자식에서 NUMERIC 부모로 향하는 FK의 허용과 반대 방향의 거부, 날짜·시간 타입 간 FK 허용을 실제 DB에서 확인했습니다. UI와 서버 adapter는 동일한 PostgreSQL 의미 검증을 사용합니다. 빈 이름, 명명 범위 내 중복과 참조 불가 후보키를 객체별로 표시합니다. [통합 테스트](../../tests/postgresql.integration.test.ts)

## PostgreSQL 17 DDL export

- 생성 대상은 표준 `public` 스키마가 있는 새 PostgreSQL 17 DB입니다. 생성기는 다른 모델 스키마를 명시적으로 만들고 테이블·타입·시퀀스 이름을 각각 인용합니다. 물리명과 설명을 사용하며 선택 옵션으로 설명을 생략할 수 있습니다. [SQL 생성기](../../packages/dialect-postgresql/src/export.ts)
- 내장 타입은 `smallint`, `integer`, `bigint`, `numeric`, `boolean`, `text`, `varchar`, `date`, `timestamp`, `timestamptz`, `uuid`, `jsonb`, `bytea` 및 등록된 별칭입니다. 지원한 타입의 인수와 배열 차원은 descriptor에서 생성합니다. 문서의 ENUM은 스키마로 수식합니다. [타입 메타데이터](../../packages/dialect-postgresql/src/ui.ts)
- DEFAULT·CHECK의 리터럴, 캐스트, 배열, 지원 연산자와 내장 함수는 AST를 검증한 뒤 재구성합니다. CHECK의 컬럼 참조는 자기 테이블로 제한합니다. DEFAULT의 `nextval`은 문자열로 지목한 문서 내 시퀀스를 찾고 선택 의존성에 포함합니다. 시퀀스 이름에 스키마가 생략되면 컬럼 소속 스키마에서 찾습니다. 사용자 정의 함수, 서브쿼리, 검토 필요로 표시된 식은 차단합니다. [식 검증](../../packages/dialect-postgresql/src/expressions.ts)
- DEFERRABLE, NOT VALID, 별도 MATCH 옵션, NULLS NOT DISTINCT, 부분·식 인덱스, GIN·GiST, domain, partition, generated column, view, trigger, function, 권한, extension은 이 릴리스의 생성 범위 밖입니다. 버전이 명시된 확장 데이터는 저장할 수 있으며 이해할 수 없는 속성이 선택에 포함되면 진단하고 내보내기를 차단합니다. [지원 범위 테스트](../../tests/ddl-export.test.ts)
- 전체·부분 fixture를 PostgreSQL 17.12에서 적용해 catalog와 삽입 동작을 검증했습니다. SQL 작업에는 adapter 버전, 대상 엔진, 원본 리비전이 함께 기록됩니다. [실행 검증](../../tests/ddl-export.integration.test.ts), [작업 검증](../../tests/sql-jobs.integration.test.ts)

## PostgreSQL 17 DDL import

UTF-8 환경에서 아래와 같이 plain schema-only 덤프를 생성합니다. 소유자와 권한을 생략하면 공유할 DDL을 구조 중심으로 확인할 수 있습니다. 데이터와 custom·tar·directory 아카이브는 구조 가져오기의 입력 범위 밖입니다.

```sh
pg_dump --schema-only --format=plain --no-owner --no-privileges design_database > schema.sql
```

예를 들어 `CREATE VIEW active_orders AS SELECT id FROM orders`와 `CREATE INDEX active_idx ON orders (id) WHERE active`는 제외 항목을 표시합니다. 남은 모델의 참조가 유효하면 사용자가 해당 제외 목록을 확인하고 적용할 수 있습니다. 기본 한도는 UTF-8 5 MiB, 10,000문장, 실행 10초입니다. [운영 한도](../operations.md#패키지-실행)

- adapter `0.3.0`의 입력은 PostgreSQL 17의 UTF-8 생성 DDL 또는 plain `pg_dump --schema-only`입니다. 덤프의 짝이 맞는 `\restrict`·`\unrestrict`와 고정 세션 설정·소유자 문은 별도 제어문으로 기록합니다. 외부 파일·명령을 호출하는 psql 입력, `COPY`, 실행 문장과 지원 범위 밖의 동적 `search_path`는 분석 오류로 처리합니다. [덤프 fixture](../../packages/test-fixtures/sql/postgresql-17-schema.sql), [전처리](../../packages/dialect-postgresql/src/import-source.ts)
- 기본 스키마는 고정 `search_path`가 지정되기 전의 비한정 이름을 해석하는 데 사용합니다. 이후 문장은 해당 위치의 path를 따릅니다. 비한정 이름에 유효한 생성 스키마가 없거나 제외된 타입·함수·키에 의존하면 적용을 차단합니다. 인용된 대소문자와 스키마가 다른 동명 객체를 보존합니다. [이름 해석과 변환](../../packages/dialect-postgresql/src/import.ts)
- 지원하는 DEFAULT·CHECK AST는 문자열·식별자·객체 참조를 보존하는 SQL로 재구성합니다. SERIAL은 정수 컬럼, 소유 시퀀스, `nextval` DEFAULT로 표현합니다. IDENTITY는 자체 생성 모드와 내부 시퀀스 이름·옵션으로 표현합니다. [변환 검증](../../tests/ddl-import.test.ts), [실제 PostgreSQL 비교](../../tests/ddl-import.integration.test.ts)
- view·function·trigger·partition·extension·권한·부분/식 인덱스와 일반 마이그레이션 명령은 제외 항목으로 표시합니다. 지원 구문 밖의 옵션을 포함한 인라인 정의는 문장 단위로 제외합니다. 독립적으로 변환할 수 있는 구조는 해당 목록을 확인한 뒤 적용할 수 있습니다. 중복·모순·문법 오류나 남은 구조에 필요한 참조가 있으면 적용을 차단합니다. [작업과 적용 검증](../../tests/sql-import-jobs.integration.test.ts)

## PoC 검증

- `tests/postgresql-parser.test.ts`의 기존 워커 검증은 인용 이름, 배열, 복합키 순서, FK 대응, 타입·제약 AST와 워커 종료를 확인했습니다. 워커 요약과 회귀 검사에는 `gen_random_uuid()` 호출, `nextval`의 스키마 한정 문자열 인수, JSONB와 빈 배열의 타입 캐스트, `"Line" > 0` CHECK의 연산자와 피연산자를 추가했습니다.
- `tests/postgresql.integration.test.ts`는 같은 fixture를 임시 DB에서 실행해 테이블 3개, FK 1개, 시퀀스 2개, IDENTITY 컬럼 1개와 JSONB·UUID·배열 컬럼을 확인했습니다. PoC에서 `pg_dump --schema-only`의 `\restrict`, `\unrestrict`는 SQL 파서에서 문법 오류를 일으켰고 해당 줄을 제외한 SQL은 파싱됐습니다. 이 결과를 바탕으로 가져오기에서 메타명령을 분리했습니다.
- 서버 전용 `@erd/dialect-postgresql/parser`는 PoC의 검사 요약을 반환합니다. 실제 가져오기는 SQL 작업 worker에서 변환한 catalog와 진단을 반환합니다. UI의 `@erd/dialect-postgresql/ui`는 메타데이터와 타입 목록을 제공합니다.
