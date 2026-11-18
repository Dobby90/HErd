# PostgreSQL 지원 상태

첫 인증 엔진은 PostgreSQL 17입니다. 격리 환경은 `postgres:17-bookworm`, Node 24.12.0, pnpm 10.11.0을 사용합니다. 호스트 의존성 준비에서 `pgsql-parser@17.9.9`와 그 WebAssembly 파서 의존성 `libpg-query@17.7.3`의 설치와 lockfile 생성을 확인했습니다. 파서 선택 기준은 PostgreSQL 서버 파서 계열의 AST를 Node 워커에서 실행할 수 있고 별도 네이티브 빌드가 필요하지 않다는 점입니다. 설치된 두 패키지의 `package.json`에 표기된 라이선스는 MIT입니다.

호스트 검증 `step-72`에서 PostgreSQL 17 AST, 워커 종료, 격리된 PostgreSQL 17의 서버 버전과 fixture 실행, 실제 스키마 덤프 분석을 확인했습니다. 검증 환경의 기동 로그에는 PostgreSQL 17.12가 기록됐으며, 통합 테스트는 `server_version_num`으로 메이저 버전 17을 확인합니다. 이 결과를 근거로 메이저 버전 17을 인증 프로필로 고정했습니다.

| 기능 | 모델 | 편집 UI | DDL import | DDL export |
| --- | --- | --- | --- | --- |
| Namespace, 테이블, 컬럼 | 지원 | 단계 2 예정 | `not-implemented` (5단계 예정) | `not-implemented` (4단계 예정) |
| 표준 타입, JSONB, 배열, UUID, 인용 식별자 | 타입·식별자 기록 | 단계 2 예정 | `not-implemented` (5단계 예정) | `not-implemented` (4단계 예정) |
| PK, UNIQUE, FK, CHECK, DEFAULT | 지원 | 단계 2 예정 | `not-implemented` (5단계 예정) | `not-implemented` (4단계 예정) |
| 일반·고유·식 인덱스, enum, sequence, identity | 지원 | 단계 2 예정 | `not-implemented` (5단계 예정) | `not-implemented` (4단계 예정) |

adapter의 import/export는 `not-implemented`를 반환합니다. 등록되지 않은 dialect와 인증되지 않은 엔진 버전은 실패 진단을 반환합니다. 알 수 없는 버전의 확장과 무효화된 식은 문서에 보존되고 SQL 생성은 차단됩니다.

## PoC 검증

- `tests/postgresql-parser.test.ts`의 기존 워커 검증은 인용 이름, 배열, 복합키 순서, FK 대응, 타입·제약 AST와 워커 종료를 확인했습니다. 워커 요약과 회귀 검사에는 `gen_random_uuid()` 호출, `nextval`의 스키마 한정 문자열 인수, JSONB와 빈 배열의 타입 캐스트, `"Line" > 0` CHECK의 연산자와 피연산자를 추가했습니다.
- `tests/postgresql.integration.test.ts`는 같은 fixture를 임시 DB에서 실행해 테이블 3개, FK 1개, 시퀀스 2개, IDENTITY 컬럼 1개와 JSONB·UUID·배열 컬럼을 확인했습니다. 실제 `pg_dump --schema-only`에 포함된 `\restrict`, `\unrestrict`는 SQL 파서에서 문법 오류를 일으켰고 해당 줄을 제외한 SQL은 파싱됐습니다. 덤프에는 `SET`, `ALTER TABLE`, enum·시퀀스·인덱스 생성문도 있었습니다. 향후 덤프 import에서는 메타명령을 분류하고 보조문을 문장별로 처리해야 합니다.
- 서버 전용 `@erd/dialect-postgresql/parser`는 워커가 만든 검사 요약을 반환합니다. 원본 AST는 워커 내부에서 처리합니다. UI의 `@erd/dialect-postgresql/ui`는 메타데이터와 타입 목록을 제공합니다. 미지원 문장과 변환 손실의 진단은 정식 import/export 단계에서 구현합니다.
