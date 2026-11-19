# HERD

HERD는 브라우저에서 PostgreSQL 17용 ERD를 설계하고 관리하는 도구입니다. 하나의 스키마에 여러 다이어그램 뷰를 만들고 같은 테이블을 각 뷰에 배치할 수 있습니다.

- **ERD 편집** — 캔버스에서 테이블·컬럼·물리 및 논리 관계를 편집합니다. 제약과 인덱스를 관리하고 변경을 실행 취소하거나 다시 실행할 수 있습니다.
- **프로젝트 저장과 공유** — 서버에 자동 저장하고 사용자 검색으로 소유자, 편집자, 조회자 권한을 관리합니다. 버전 이력에서 스냅샷을 열거나 복원할 수 있습니다. 서버에 저장되지 않은 변경은 브라우저 복구본에서 다시 열 수 있습니다.
- **PostgreSQL DDL** — SQL을 분석해 새 ERD를 만들거나, 현재 뷰에 테이블을 추가하거나, 기존 모델을 교체합니다. 서버에 저장된 스키마 전체, 현재 뷰, 선택한 테이블을 SQL로 내보낼 수 있습니다.
- **이미지 출력** — 현재 뷰 전체나 선택한 테이블을 SVG 또는 PNG로 내려받습니다.

화면별 사용법은 [편집기 사용법](#편집기-사용법)에서 확인하세요.

## 빠른 시작

### 소스에서 개발 서버 실행

Node.js **24.12.0**과 pnpm **10.11.0**을 준비하고 저장소 루트에서 실행합니다.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

[프로젝트 화면](http://127.0.0.1:5173/)을 열 수 있습니다. 로그인과 ERD 편집에는 서비스 DB와 인증 설정이 필요합니다. Vite가 같은 주소의 `/api` 요청을 `127.0.0.1:3001`로 전달합니다. 포트를 바꾸려면 [.env.example](.env.example)의 `WEB_PORT`와 `API_PORT`를 참고해 루트의 `.env`에 값을 지정하세요.

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

프로젝트 화면의 **개발 계정으로 로그인**에서 프로젝트와 ERD를 만듭니다. 포트를 변경했다면 `DATABASE_URL`의 포트를 `HERD_DB_PORT`와, `APP_ORIGIN`의 포트를 `WEB_PORT`와 맞추세요.

### Compose로 전체 스택 실행

이 명령은 `.env.example`을 사용해 로컬용 기본값으로 웹, API, 마이그레이션, PostgreSQL 17.12를 실행합니다. [웹 화면](http://127.0.0.1:8080/)에서 개발 계정으로 로그인할 수 있습니다.

```sh
docker compose --env-file .env.example up -d --build --wait
curl -fsS http://127.0.0.1:8080/api/health
curl -fsS http://127.0.0.1:8080/api/ready
```

`/api/health`는 API 프로세스의 상태를, `/api/ready`는 DB 연결과 마이그레이션 이력 및 SQL 작업 초기화 상태를 확인합니다. PostgreSQL 데이터는 Compose의 `herd-db` 볼륨에 저장됩니다.

## 편집기 사용법

- 캔버스 상단의 **+ 테이블**로 새 테이블을 배치합니다. 기존 테이블은 왼쪽 스키마 목록에서 끌어놓습니다. 테이블명, 컬럼명, 자료형은 더블클릭해 코멘트와 컬럼 기본값을 포함한 편집 화면을 엽니다. **이름 표시 → 전체 보기**에서 물리명과 논리명을 함께 볼 수 있습니다. 테이블 코멘트는 **속성 → 이름·배치 → 설명**에서 확인합니다.
- ERD 제목 옆의 **ERD 표시 옵션**에서 테이블·컬럼 코멘트, 컬럼 목록·자료형·기본값·키 배지, 관계선과 라벨, 메모·그룹, 배경 격자를 조절합니다. **NULL 허용 여부**를 켜면 컬럼에 `NULL` 또는 `NOT NULL` 배지가 표시됩니다. 코멘트와 NULL 허용 여부는 기본으로 숨겨집니다. 설정은 ERD에 저장되고 모든 뷰의 캔버스에 적용됩니다.
- **관계 연결**에서 식별 FK, 비식별 FK, 논리 관계를 선택합니다. 선택·이동 모드는 포인터와 손 아이콘 또는 `V`와 `H`로 전환합니다. 선택한 테이블·메모·그룹은 카드의 휴지통에서 삭제할 수 있습니다. 그룹을 삭제하면 포함된 테이블과 메모는 그룹에서 분리됩니다.
- 캔버스에서 그룹을 선택하고 가장자리나 모서리를 끌어 너비와 높이를 조절합니다. 그룹명이나 메모를 더블클릭하거나 선택한 카드의 연필 버튼을 누르면 캔버스에서 텍스트와 색상을 편집할 수 있습니다. **기본 색상**을 선택하면 원래 색으로 돌아갑니다. 지정한 색상은 SVG와 PNG 내보내기에도 적용됩니다.
- 캔버스에서 테이블을 선택하면 속성 패널에서 컬럼, 제약, 인덱스, 이름·배치를 편집할 수 있습니다. 모바일에서는 상단의 **속성** 탭을 엽니다. 너비가 지정되지 않은 테이블 카드는 현재 뷰에 보이는 이름에 맞춰 넓어집니다. **이름순 그리드 재배치**는 계산된 카드 너비에 맞춰 간격을 잡습니다.
- 테이블 카드의 **컬럼 개수** 버튼으로 목록을 접거나 펼칩니다. 폭이 좁으면 자료형과 배지가 이름 아래에 배치됩니다. **속성 → 이름·배치 → 자동 너비로 되돌리기**는 카드에 저장된 크기를 지우고 콘텐츠에 맞춰 너비를 계산합니다. **겹친 카드 정리**는 겹치는 테이블을 이동하고 필요한 경우 해당 그룹의 크기를 늘립니다. 테이블에 마우스를 올리거나 관계 연결을 시작하면 컬럼 연결점이 나타납니다.
- 왼쪽 패널에서 **스키마 접기**를 누르면 캔버스가 넓어집니다. 패널은 **스키마 펼치기**로 다시 열 수 있습니다. 모바일에서는 상단의 **스키마** 탭을 누릅니다.
- 서버 ERD는 자동 저장되며 편집기 상단에 저장 상태와 리비전이 표시됩니다. **버전 이력**에서 스냅샷을 열거나 복원하고, **내보내기**에서 DDL·SVG·PNG를 선택합니다.
- 프로젝트 소유자는 상세 화면 상단의 **멤버 관리 → 멤버 추가**에서 가입 계정을 표시 이름이나 로그인 아이디로 검색합니다. 편집자 또는 조회자를 선택하고 **프로젝트에 추가**를 누르면 상대의 **공유받은 프로젝트**에 바로 나타납니다. 소유자 지정, 역할 변경, 권한 회수는 멤버 목록에서 합니다.
- 프로젝트 상세 화면의 ERD 작업 영역에서 **새 ERD**를 만들거나 **가져오기**를 열 수 있습니다.
- 이전 로컬 편집기 작업은 작업했던 브라우저 프로필과 서비스 주소에서 이전합니다. 로그인한 뒤 편집 권한이 있는 프로젝트에서 **로컬 작업 옮기기** 또는 **가져오기 → 로컬 복구본 가져오기**를 선택합니다. 원본은 브라우저에 보관되고 서버에는 새 ERD가 만들어집니다. 서버 ERD의 미저장 변경은 해당 문서의 **브라우저 복구본**에서 다시 열 수 있습니다.
- 서비스 관리자는 프로젝트 화면의 **관리자 → 사용자 관리**에서 계정을 검색하고 상태를 변경합니다. 비활성화하면 기존 세션이 종료됩니다. 해당 계정이 유일한 활성 소유자인 프로젝트가 있으면 먼저 다른 소유자를 지정합니다.

## PostgreSQL DDL 지원 범위

가져올 SQL은 직접 붙여 넣거나 UTF-8 `.sql` 파일로 올릴 수 있습니다. `pg_dump --schema-only`의 plain 형식도 지원하며 입력 한도는 기본 5 MiB입니다. 격리된 워커의 문장별 분석 결과에서 제외되는 항목을 확인한 뒤 적용합니다.

서버 ERD의 **가져오기** 메뉴에서 현재 뷰에 테이블을 추가하거나 모델을 교체합니다. 일반 테이블, 주요 내장 타입, PK·UNIQUE·FK, 지원하는 DEFAULT·CHECK 식과 B-tree 인덱스를 처리합니다. 뷰·함수·트리거, 파티션, 부분·식 인덱스는 지원 범위 밖입니다.

뷰나 테이블만 내보낼 때도 필요한 FK 대상, ENUM, 시퀀스, 스키마가 생성 범위에 포함됩니다. 결과는 복사하거나 `.sql`로 내려받아 새 PostgreSQL 17 DB에 적용할 수 있습니다. 세부 지원 범위는 [가져오기 테스트](tests/ddl-import.test.ts)와 [내보내기 테스트](tests/ddl-export.test.ts)에서 확인할 수 있습니다.

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

`docs/`는 로컬 문서 공간으로 사용하며 Git 추적에서 제외합니다.

## 개발 검증

| 명령 | 검증 범위 |
| --- | --- |
| `pnpm typecheck`, `pnpm lint` | TypeScript 타입 검사와 ESLint |
| `pnpm test` | 단위 테스트와 Chromium 기반 편집기 테스트 |
| `pnpm test:integration` | 임시 PostgreSQL 17 클러스터를 이용한 저장·인증·SQL 검증과 Chromium 브라우저 테스트 |
| `pnpm build` | 운영 빌드 생성 (`dist/web`, `dist/api`) |
| `pnpm test:release` | `pnpm build` 이후 운영 빌드 흐름, 성능, 입력 한도, 백업·복원 검증 |

브라우저 테스트는 기본적으로 `/usr/bin/chromium`을 사용합니다. 로컬 실행 파일 경로는 `CHROMIUM_PATH`로 지정할 수 있습니다. PostgreSQL 실행 파일과 Chromium이 포함된 [Docker 검증 대상](Dockerfile)으로 [CI 검증](.github/workflows/verify.yml)을 재현할 수 있습니다. Compose 패키지는 `sh scripts/release-compose.sh`로 검증합니다.

## 릴리스와 운영

Git 태그와 서버 플랫폼을 지정하면 해당 커밋의 웹·API 이미지를 패키징합니다. 아래 예시는 `v0.4.2`의 `linux/amd64` 패키지를 `build/releases/v0.4.2-linux-amd64/`에 만듭니다.

```sh
sh scripts/release.sh v0.4.2 linux/amd64
```

운영에서는 HTTPS `APP_ORIGIN`과 서비스 DB를 설정하고 자체 계정 또는 OIDC를 활성화합니다. Compose에서는 `HERD_NODE_ENV=production`과 `HERD_DEV_LOGIN=0`을 사용합니다. 자체 계정은 Compose의 `HERD_LOCAL_AUTH=1` 또는 API 자체 실행의 `ERD_LOCAL_AUTH=1`로 켭니다. OIDC를 사용하면 공급자에 `<APP_ORIGIN>/api/auth/callback`을 등록합니다.

서비스 관리자 지정은 운영 DB에서 수행합니다. 지정할 사람이 먼저 로그인한 뒤 `GET /api/me` 응답의 `user.id`를 확인하고, 마이그레이션이 적용된 서비스 DB에서 해당 UUID만 갱신합니다. 이후 프로젝트 화면을 새로 열면 관리자 메뉴가 표시됩니다.

```sql
UPDATE users SET is_admin = true
WHERE id = '<확인한 사용자 UUID>'::uuid AND disabled_at IS NULL
RETURNING id;
```

배포 서버에서는 패키지 디렉터리에서 다음 명령을 실행합니다. `production.env`에 공개 origin, DB 연결과 인증 설정을 지정합니다.

```sh
docker image load -i images.tar.gz
docker compose --env-file production.env --env-file release.env pull db
docker compose --env-file production.env --env-file release.env up -d --no-build --pull never --wait
```

Compose는 DB가 준비되면 마이그레이션을 적용하고 API를 시작합니다. 운영 변경 전에는 서비스 DB를 `pg_dump -Fc`로 백업하고, 별도 DB에 `pg_restore`로 복원해 확인합니다. 서비스 백업과 복원의 검증 절차는 [운영 릴리스 테스트](tests/operations.release.test.ts)에서 확인할 수 있습니다.
