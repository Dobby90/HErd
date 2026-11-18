# PostgreSQL 지원 상태

첫 검증 대상은 PostgreSQL 17입니다. 격리 환경은 `postgres:17-bookworm`, Node 24.12.0, pnpm 10.11.0을 사용합니다. 호스트 의존성 준비에서 `pgsql-parser@17.9.9`와 그 WebAssembly 파서 의존성 `libpg-query@17.7.3`의 설치와 lockfile 생성을 확인했습니다. 파서 선택 기준은 PostgreSQL 서버 파서 계열의 AST를 Node 워커에서 실행할 수 있고 별도 네이티브 빌드가 필요하지 않다는 점입니다. 설치된 두 패키지의 `package.json`에 표기된 라이선스는 MIT입니다.

PostgreSQL 17의 인증 상태는 검증 후보입니다. 워커 결과의 AST 엔진 버전과 테스트 DB의 `server_version_num`은 각각 실행 시 검사합니다. 워커와 실제 DB 및 덤프 검증은 Tester의 실행 근거를 기다립니다.

| 기능 | 모델 | 편집 UI | DDL import | DDL export |
| --- | --- | --- | --- | --- |
| Namespace, 테이블, 컬럼 | 지원 | 단계 2 예정 | 단계 5 예정 | 단계 4 예정 |
| 표준 타입, JSONB, 배열, UUID, 인용 식별자 | 타입·식별자 기록 | 단계 2 예정 | 단계 5 예정 | 단계 4 예정 |
| PK, UNIQUE, FK, CHECK, DEFAULT | 지원 | 단계 2 예정 | 단계 5 예정 | 단계 4 예정 |
| 일반·고유·식 인덱스, enum, sequence, identity | 지원 | 단계 2 예정 | 단계 5 예정 | 단계 4 예정 |

adapter의 import/export는 `not-implemented`를 반환합니다. 등록되지 않은 dialect와 지원 프로필에 없는 버전은 실패 진단을 반환합니다. 알 수 없는 버전의 확장과 무효화된 식은 문서에 보존되고 SQL 생성은 차단됩니다.

## PoC 검증

- `tests/postgresql-parser.test.ts`는 통제된 일반 SQL에서 인용 이름, 배열, 복합키의 순서, FK 대응, 타입·제약 AST와 워커 종료를 검사합니다. 문법 오류, 입력 한도, 취소도 확인합니다.
- `tests/postgresql.integration.test.ts`는 같은 fixture를 임시 DB에서 실행하고 스키마 객체와 실제 `pg_dump --schema-only` 출력을 검사합니다. 최근 패치 버전의 덤프에서 `\restrict`와 `\unrestrict`를 SQL 파서에 직접 전달할 때의 오류와 PoC에서 해당 줄을 제외한 뒤의 AST를 확인합니다. 향후 덤프 import에서는 메타명령을 분류하고 `SET`, `ALTER TABLE` 같은 보조문을 문장별로 처리해야 합니다.
- 서버 전용 워커 내부에서 AST를 읽고 PoC 검증에 필요한 요약만 반환합니다. UI entry point는 메타데이터와 타입 목록을 제공합니다. 미지원 문장과 변환 손실의 진단은 정식 import/export 단계에서 구현합니다.
