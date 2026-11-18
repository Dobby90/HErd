# ERD 도구

Node.js 24.12.0과 pnpm 10.11.0을 사용합니다. Docker 기반 검증 구성은 `devorchestra.environment.json`에 있습니다. 일반 개발에서는 지정 버전의 도구를 선택한 뒤 다음 명령을 저장소 루트에서 실행합니다.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

브라우저에서 <http://127.0.0.1:5173>을 열면 주문 관리 샘플이 편집기로 열립니다. 새 문서에서 PostgreSQL 17을 선택하고 스키마와 뷰를 설계할 수 있습니다. API의 liveness는 `GET /api/health`로 확인합니다. 웹 개발 서버는 `/api`를 3001 포트로 프록시합니다. 포트를 바꾸려면 `.env.example`을 `.env`에 복사하고 값을 수정하세요.

| 명령 | 내용 |
| --- | --- |
| `pnpm build` | 웹과 API의 운영 빌드를 `dist/web`과 `dist/api`에 생성 |
| `pnpm typecheck` | 앱, 공통 패키지, 검증 코드의 TypeScript 검사 |
| `pnpm lint` | TypeScript 소스의 ESLint 검사 |
| `pnpm test` | 모델과 웹의 Vitest unit 프로젝트를 단일 실행하며 브라우저 시나리오는 Chromium 사용 |
| `pnpm test:integration` | PostgreSQL 17의 스키마 덤프·프로젝트 API·OIDC 검증과 Chromium 서버 저장 E2E |
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

## 진행 상태

- [x] **1단계 개발 기반과 도메인 모델 완료.** 웹·API 실행, ERD v1 직렬화와 참조 무결성, PostgreSQL 17 파서·실제 스키마 덤프를 검증했습니다. [1단계 검증 결과](docs/01-foundation-and-domain.md#검증-결과)
- [x] **2단계 로컬 ERD 편집기 완료.** 복합·자기 참조 FK 편집, 여러 뷰의 테이블 재사용, 삭제와 실행 취소·다시 실행, IndexedDB 복구와 탭 충돌 처리를 검증했습니다. [2단계 검증 결과](docs/02-erd-editor.md#검증-결과)
- [x] **3단계 프로젝트·인증·서버 저장 완료.** OIDC와 역할별 권한, 실제 DB의 프로젝트·ERD CRUD, 자동 저장·충돌·복구를 검증했습니다. [3단계 검증 결과](docs/03-projects-and-persistence.md#검증-결과)
- [ ] **4단계 PostgreSQL DDL 내보내기 예정.** [4단계 계획](docs/04-postgresql-ddl-export.md)

2026-11-18 Docker 검증에서 클린 설치, 빌드·타입 검사·lint, 기본 테스트 38개, 통합 테스트 3개가 통과했습니다. OIDC는 모의 공급자로 검증했으며 운영 계정 연동은 배포 환경에서 확인합니다.

- [단계별 계획](docs/README.md)
- [PostgreSQL 지원 상태](docs/sql-support/postgresql.md)
