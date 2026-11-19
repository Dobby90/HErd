# ERD 도구

Node.js 24.12.0과 pnpm 10.11.0을 사용합니다. Docker 기반 검증 구성은 `devorchestra.environment.json`에 있습니다. 일반 개발에서는 지정 버전의 도구를 선택한 뒤 다음 명령을 저장소 루트에서 실행합니다.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

브라우저에서 <http://127.0.0.1:5173>을 열면 주문 관리 샘플이 편집기로 열립니다. 새 문서에서 PostgreSQL 17을 선택하고 스키마와 뷰를 설계할 수 있습니다. API의 liveness는 `GET /api/health`로 확인합니다. 웹 개발 서버는 `/api`를 3001 포트로 프록시합니다. 포트를 바꾸려면 `.env.example`을 `.env`에 복사하고 값을 수정하세요.

의존성을 설치한 뒤 `./start.sh`로 웹과 API를 백그라운드에서 실행하고 `./stop.sh`로 종료할 수 있습니다. 로그는 `build/run/dev.log`에 기록됩니다.

| 명령 | 내용 |
| --- | --- |
| `pnpm build` | 웹과 API의 운영 빌드를 `dist/web`과 `dist/api`에 생성 |
| `pnpm typecheck` | 앱, 공통 패키지, 검증 코드의 TypeScript 검사 |
| `pnpm lint` | TypeScript 소스의 ESLint 검사 |
| `pnpm test` | 모델과 웹의 Vitest unit 프로젝트를 단일 실행하며 브라우저 시나리오는 Chromium 사용 |
| `pnpm test:integration` | PostgreSQL 17에서 저장·OIDC·DDL 입출력·SQL 작업 검증과 Chromium E2E |
| `pnpm test:release` | 운영 빌드의 브라우저 흐름·성능·입력 경계·백업/복원 검증. `pnpm build` 후 실행 |
| `pnpm db:migrate` | `DATABASE_URL`의 서비스 DB에 버전 관리된 마이그레이션 적용 |

브라우저 테스트는 Docker 도구 구성에 포함된 Chromium을 사용합니다. 일반 개발 환경에서는 `CHROMIUM_PATH`에 설치한 Chromium 실행 파일을 지정할 수 있습니다.

통합 검증은 PostgreSQL 17 실행 파일이 있는 Docker 환경에서 실행합니다. 테스트는 임시 데이터와 서버 로그를 `build`에 두고 컨테이너 내부의 `127.0.0.1` 임시 TCP 포트로 접속합니다. 내장 fixture를 실행한 뒤 클러스터와 임시 디렉터리를 정리합니다. 루트로 시작된 컨테이너에서는 PostgreSQL 프로세스가 컨테이너의 `postgres` 사용자로 실행됩니다.

커밋한 편집과 실행 취소·다시 실행은 IndexedDB에 익명 로컬 복구본으로 저장됩니다. 저장 완료 후 새로고침하면 해당 복구본이 열립니다. 다른 탭의 저장이 앞섰으면 늦은 편집은 충돌마다 별도 복구본으로 남습니다. 탐색 패널에서 각 복구본을 선택해 이어서 편집할 수 있습니다. 저장이나 복구에 실패하면 상단 상태에서 다시 시도할 수 있습니다.

## 프로젝트와 서버 저장

로컬에서 서버 저장을 사용하려면 `.env.example`을 바탕으로 `.env`에 `DATABASE_URL`, `APP_ORIGIN`, `NODE_ENV=development`, `ERD_DEV_LOGIN=1`을 설정합니다. 예시에 적힌 DB 주소는 아래 Compose 서비스의 기본값입니다.

```sh
docker compose up -d --wait db
pnpm db:migrate
pnpm dev
```

편집기 상단의 **프로젝트**에서 개발 계정으로 로그인합니다. 프로젝트와 ERD를 만든 뒤 편집하면 마지막 변경 약 1초 후 서버 저장이 시작됩니다. 저장이 충돌하면 서버 최신본을 확인하거나 내 변경을 새 ERD로 복제할 수 있습니다. 오프라인 편집과 서버 저장 실패 시에는 해당 계정과 기준 리비전에 연결된 브라우저 복구본을 유지합니다. 로그인 전 작업은 프로젝트의 **로컬 복구본 가져오기**에서 선택해 새 ERD로 저장합니다.

OIDC를 사용하려면 `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`을 설정하고 공급자에 `<APP_ORIGIN>/api/auth/callback`을 등록합니다. 클라이언트는 Authorization Code, PKCE S256, `client_secret_basic`을 사용합니다. 운영에서 `NODE_ENV=production`과 HTTPS `APP_ORIGIN`을 설정하고 `pnpm db:migrate`를 실행한 뒤 API를 `node --env-file-if-exists=.env dist/api/main.js`로 시작합니다. 프록시는 같은 HTTPS origin에서 `dist/web`과 `/api`를 제공해야 합니다. [인증·DB 설정 및 검증](docs/03-projects-and-persistence.md#실행과-인증-설정)

## PostgreSQL DDL 내보내기

서버에 저장된 ERD에서 **내보내기 → DDL 내보내기**를 엽니다. 전체 스키마, 현재 뷰, 선택한 테이블 중 범위를 고릅니다. 뷰나 테이블을 선택하면 FK 대상, ENUM, 시퀀스, 스키마가 얼마나 추가되는지 생성 전에 확인할 수 있습니다. 편집 중인 문서는 먼저 저장하고, viewer는 최신 서버 리비전으로 생성합니다. 성공한 SQL은 원본 리비전과 함께 미리보기·복사·UTF-8 `.sql` 다운로드로 제공됩니다.

SQL 작업 결과는 기본 10분 동안 보관됩니다. 생성 스크립트의 적용 대상은 새 PostgreSQL 17 데이터베이스입니다. 주문 관리 샘플의 식 인덱스를 포함해 현재 지원 범위를 벗어난 객체가 선택에 들어가면 진단을 표시합니다. [PostgreSQL 지원 범위](docs/sql-support/postgresql.md), [SQL 작업 설정](docs/04-postgresql-ddl-export.md#실행과-작업-설정)

## PostgreSQL DDL 가져오기

프로젝트에서 **DDL로 새 ERD 만들기**를 열거나 서버 편집기에서 **DDL로 모델 교체**를 엽니다. PostgreSQL 17 DDL을 붙여 넣거나 UTF-8 `.sql` 또는 텍스트 형식의 `pg_dump --schema-only` 파일을 선택합니다. 기본 입력 한도는 5 MiB입니다. 분석에서 이름 해석 결과와 문장별 판정을 확인하고, 제외 항목이 있을 때는 해당 분석의 손실 목록을 확인한 뒤 적용합니다.

편집기의 **가져오기 → DDL로 테이블 추가**는 현재 뷰에 새 테이블을 배치합니다. **DDL로 모델 교체**로 모델과 뷰를 함께 교체할 수 있습니다. 두 방식 모두 현재 서버 리비전을 확인하며 적용 직전 상태를 **버전 이력**에서 열거나 복원할 수 있습니다. [가져오기 API와 설정](docs/05-postgresql-ddl-import.md#실행과-적용-설정), [PostgreSQL 지원 범위](docs/sql-support/postgresql.md#postgresql-17-ddl-import)

## 프로젝트 공유·버전 이력·이미지 출력

프로젝트 owner는 **멤버 관리**에서 가입한 사용자의 공유 코드를 확인해 역할을 부여하거나 회수합니다. 공유 코드는 로그인한 계정의 **내 공유 코드**에서 확인할 수 있습니다. Viewer는 읽기 전용 편집기에서 현재 모델의 SQL과 뷰 이미지를 내보낼 수 있습니다.

편집기의 **버전 이력**에서 수동 스냅샷을 저장하고 과거 버전을 읽기 전용으로 엽니다. 복원하면 기존 상태가 보존되고 복원 결과가 새 리비전에 저장됩니다. **내보내기 → 이미지 내보내기**에서는 현재 뷰 전체 또는 선택한 테이블을 SVG·PNG로 출력합니다. 기존 서비스 DB에는 `pnpm db:migrate`로 6단계 마이그레이션을 적용합니다. [권한·이력·출력 설정](docs/06-sharing-history-and-images.md#사용과-설정)

## 배포 패키지

첫 릴리스는 `v0.1.0`입니다. 버전과 배포 서버의 플랫폼을 지정하면 해당 Git 태그의 웹·API 이미지를 패키징합니다.

```sh
sh scripts/release.sh v0.1.0 linux/amd64
```

패키지는 `build/releases/v0.1.0-linux-amd64/`에 생성됩니다. 새 버전의 태그를 만드는 방법과 서버에서 이미지를 불러오는 절차는 운영 가이드에 있습니다. [버전별 릴리스](docs/operations.md#버전별-릴리스)

소스에서 로컬 스택을 실행하려면 다음 명령을 사용합니다.

```sh
docker compose up -d --build --wait
```

로컬 패키지는 `http://127.0.0.1:8080`에서 실행됩니다. 고정된 PostgreSQL 17.12 이미지가 준비된 뒤 마이그레이션을 적용하고 API와 웹을 시작합니다. `/api/health`는 프로세스 상태, `/api/ready`는 DB와 마이그레이션까지 확인합니다. 기존 서비스 DB의 운영·복구 절차와 환경변수는 운영 가이드에서 확인할 수 있습니다. [운영 가이드](docs/operations.md), [사용 가이드](docs/user-guide.md), [검증 재현 방법](docs/release-validation.md#재현-방법)

## 진행 상태

- [x] **v0.4.0 캔버스 직접 편집.** 테이블·컬럼 편집과 드래그 배치, 컬럼 순서 변경, 식별·비식별 FK 및 논리 관계 연결을 지원합니다. [캔버스 사용 가이드](docs/user-guide.md#캔버스에서-편집하기)
- [x] **v0.3.0 프로젝트·편집기 개선.** 프로젝트 목록·상세, ERD 미리보기, 라이트·다크 모드, 편집 중인 뷰에 PostgreSQL DDL로 테이블 추가를 지원합니다. [사용 가이드](docs/user-guide.md)
- [x] **1단계 개발 기반과 도메인 모델 완료.** 웹·API 실행, ERD v1 직렬화와 참조 무결성, PostgreSQL 17 파서·실제 스키마 덤프를 검증했습니다. [1단계 검증 결과](docs/01-foundation-and-domain.md#검증-결과)
- [x] **2단계 로컬 ERD 편집기 완료.** 복합·자기 참조 FK 편집, 여러 뷰의 테이블 재사용, 삭제와 실행 취소·다시 실행, IndexedDB 복구와 탭 충돌 처리를 검증했습니다. [2단계 검증 결과](docs/02-erd-editor.md#검증-결과)
- [x] **3단계 프로젝트·인증·서버 저장 완료.** OIDC와 역할별 권한, 실제 DB의 프로젝트·ERD CRUD, 자동 저장·충돌·복구를 검증했습니다. [3단계 검증 결과](docs/03-projects-and-persistence.md#검증-결과)
- [x] **4단계 PostgreSQL DDL 내보내기 완료.** 생성 SQL의 PostgreSQL 17 실행과 catalog 의미, 부분 선택 의존성, 작업 권한·격리, UTF-8 다운로드를 검증했습니다. [4단계 검증 결과](docs/04-postgresql-ddl-export.md#검증-결과)
- [x] **5단계 PostgreSQL DDL 가져오기 완료.** PostgreSQL 17 덤프의 모델 변환, 문장별 진단, 새 ERD 생성과 리비전 기반 교체를 검증했습니다. [5단계 검증 결과](docs/05-postgresql-ddl-import.md#검증-결과)
- [x] **6단계 공유·이력·이미지 출력 완료.** 멤버 역할 관리, 원자적 버전 복원, PNG·SVG의 범위와 출력 품질을 검증했습니다. [6단계 검증 결과](docs/06-sharing-history-and-images.md#검증-결과)
- [x] **7단계 안정화와 배포 준비 완료.** PostgreSQL MVP의 운영 빌드, 두 규모 성능, 별도 DB 복원과 Compose 패키지를 검증했습니다. [7단계 검증 결과](docs/release-validation.md)
- [ ] **8단계 SQL 구문·DBMS 확장 선택 단계.** [8단계 계획](docs/08-sql-extension.md)

2026-11-19 Docker 검증에서 클린 설치, 빌드·타입 검사·lint, 기본 테스트 43개, 통합 테스트 13개, 릴리스 테스트 4개가 통과했습니다. OIDC는 모의 공급자로 검증했습니다.

- [단계별 계획](docs/README.md)
- [PostgreSQL 지원 상태](docs/sql-support/postgresql.md)
