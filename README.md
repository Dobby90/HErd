# HERD

HERD는 브라우저에서 PostgreSQL 17용 ERD를 설계하고 관리하는 도구입니다. 하나의 스키마에 여러 다이어그램 뷰를 만들고 같은 테이블을 각 뷰에 배치할 수 있습니다.

- **ERD 편집** — 캔버스에서 테이블·컬럼·물리 및 논리 관계를 편집합니다. 제약과 인덱스를 관리하고 변경을 실행 취소하거나 다시 실행할 수 있습니다.
- **프로젝트 저장과 공유** — 서버에 자동 저장하고 `owner`, `editor`, `viewer` 권한으로 공유합니다. 버전 이력에서 스냅샷을 열거나 복원할 수 있습니다. 로컬 작업과 서버 저장에 실패한 변경은 브라우저에서 복구할 수 있습니다.
- **PostgreSQL DDL** — SQL을 분석해 새 ERD를 만들거나, 현재 뷰에 테이블을 추가하거나, 기존 모델을 교체합니다. 서버에 저장된 스키마 전체, 현재 뷰, 선택한 테이블을 SQL로 내보낼 수 있습니다.
- **이미지 출력** — 현재 뷰 전체나 선택한 테이블을 SVG 또는 PNG로 내려받습니다.

화면별 사용법은 [사용 가이드](docs/user-guide.md)에서 확인하세요.

## 빠른 시작

### 소스에서 로컬 편집기 실행

Node.js **24.12.0**과 pnpm **10.11.0**을 준비하고 저장소 루트에서 실행합니다. 로컬 편집에는 DB와 계정 설정이 필요 없습니다.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

[로컬 편집기](http://127.0.0.1:5173/)를 열면 주문 관리 샘플에서 시작할 수 있습니다. 편집 내용은 브라우저의 IndexedDB 복구본에 저장됩니다. Vite가 같은 주소의 `/api` 요청을 `127.0.0.1:3001`로 전달합니다. 포트를 바꾸려면 [.env.example](.env.example)의 `WEB_PORT`와 `API_PORT`를 참고해 루트의 `.env`에 값을 지정하세요.

백그라운드로 실행하려면 `./start.sh`, 종료하려면 `./stop.sh`를 사용합니다. 로그는 `build/run/dev.log`에 기록됩니다.

### 개발 환경에서 서버 저장 사용

Docker와 Compose V2를 준비합니다. `.env.example`을 `.env`로 복사하거나 기존 `.env`에 아래 항목을 설정합니다.

```dotenv
DATABASE_URL=postgresql://herd:herd-local-only@127.0.0.1:55432/herd
APP_ORIGIN=http://127.0.0.1:5173
NODE_ENV=development
ERD_DEV_LOGIN=1
```

```sh
docker compose up -d --wait db
pnpm db:migrate
pnpm dev
```

편집기의 **프로젝트 → 개발 계정으로 로그인**에서 프로젝트와 ERD를 만듭니다. 로컬 편집기에서 작업하던 ERD는 프로젝트의 **로컬 복구본 가져오기**로 옮길 수 있습니다. 포트를 변경했다면 `DATABASE_URL`의 포트를 `HERD_DB_PORT`와, `APP_ORIGIN`의 포트를 `WEB_PORT`와 맞추세요.

### Compose로 전체 스택 실행

이 명령은 `.env.example`을 사용해 로컬용 기본값으로 웹, API, 마이그레이션, PostgreSQL 17.12를 실행합니다. [웹 화면](http://127.0.0.1:8080/)에서 개발 계정으로 로그인할 수 있습니다.

```sh
docker compose --env-file .env.example up -d --build --wait
curl -fsS http://127.0.0.1:8080/api/health
curl -fsS http://127.0.0.1:8080/api/ready
```

`/api/health`는 API 프로세스의 상태를, `/api/ready`는 DB 연결과 마이그레이션 이력 및 SQL 작업 초기화 상태를 확인합니다. PostgreSQL 데이터는 Compose의 `herd-db` 볼륨에 저장됩니다.

## PostgreSQL DDL 지원 범위

가져올 SQL은 직접 붙여 넣거나 UTF-8 `.sql` 파일로 올릴 수 있습니다. `pg_dump --schema-only`의 plain 형식도 지원하며 입력 한도는 기본 5 MiB입니다. 격리된 워커의 문장별 분석 결과에서 제외되는 항목을 확인한 뒤 적용합니다.

뷰나 테이블만 내보낼 때도 필요한 FK 대상, ENUM, 시퀀스, 스키마가 생성 범위에 포함됩니다. 결과는 복사하거나 `.sql`로 내려받아 새 PostgreSQL 17 DB에 적용할 수 있습니다. [지원 구문과 제한](docs/sql-support/postgresql.md)

## 저장소 구성

TypeScript 기반 pnpm 워크스페이스입니다. 웹은 React·React Flow·Vite, API는 Node.js·Fastify를 사용합니다. PostgreSQL에 프로젝트와 ERD 문서, 리비전, SQL 작업을 저장합니다.

| 경로 | 역할 |
| --- | --- |
| `apps/web` | 프로젝트 화면, ERD 편집기, 브라우저 복구, 이미지 출력 |
| `apps/api` | 인증·권한, 프로젝트·문서·이력 API, SQL 작업 큐와 워커 |
| `packages/model` | 공통 ERD 문서 스키마, 참조 무결성, 편집 명령과 이력 |
| `packages/sql-contract`, `packages/sql-service` | SQL dialect 계약, 어댑터 등록과 처리 조율 |
| `packages/dialect-postgresql` | PostgreSQL 타입·진단, DDL 분석과 생성 |
| `packages/test-fixtures`, `tests` | 공유 예제와 테스트 데이터, 단위·브라우저·통합·릴리스 검증 |
| `db/migrations`, `deploy`, `scripts` | 서비스 DB 마이그레이션, Nginx 구성, 개발·릴리스 스크립트 |

## 개발 검증

| 명령 | 검증 범위 |
| --- | --- |
| `pnpm typecheck`, `pnpm lint` | TypeScript 타입 검사와 ESLint |
| `pnpm test` | 단위 테스트와 Chromium 기반 편집기 테스트 |
| `pnpm test:integration` | 임시 PostgreSQL 17 클러스터를 이용한 저장·인증·SQL 검증과 Chromium 브라우저 테스트 |
| `pnpm build` | 운영 빌드 생성 (`dist/web`, `dist/api`) |
| `pnpm test:release` | `pnpm build` 이후 운영 빌드 흐름, 성능, 입력 한도, 백업·복원 검증 |

브라우저 테스트는 기본적으로 `/usr/bin/chromium`을 사용합니다. 로컬 실행 파일 경로는 `CHROMIUM_PATH`로 지정할 수 있습니다. PostgreSQL 실행 파일과 Chromium이 포함된 Docker 환경에서 CI 검증을 재현할 수 있습니다. [릴리스 검증 재현 방법](docs/release-validation.md#재현-방법)

## 릴리스와 운영

Git 태그와 서버 플랫폼을 지정하면 해당 커밋의 웹·API 이미지를 패키징합니다. 아래 예시는 `v0.4.2`의 `linux/amd64` 패키지를 `build/releases/v0.4.2-linux-amd64/`에 만듭니다.

```sh
sh scripts/release.sh v0.4.2 linux/amd64
```

운영에서는 HTTPS `APP_ORIGIN`과 서비스 DB를 설정하고 자체 계정 또는 OIDC를 활성화합니다. Compose에서는 `HERD_NODE_ENV=production`과 `HERD_DEV_LOGIN=0`을 사용합니다. 자체 계정은 Compose의 `HERD_LOCAL_AUTH=1` 또는 API 자체 실행의 `ERD_LOCAL_AUTH=1`로 켭니다. OIDC를 사용하면 공급자에 `<APP_ORIGIN>/api/auth/callback`을 등록합니다.

- 배포 환경변수, 마이그레이션, 백업과 복원은 [운영 가이드](docs/operations.md)를 참고하세요.
- 설계 결정과 단계별 구현 기록은 [개발 문서](docs/README.md)에서 확인할 수 있습니다.
