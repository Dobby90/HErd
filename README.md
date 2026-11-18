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
| `pnpm test:integration` | PostgreSQL 17에서 테스트 전용 클러스터와 schema-only dump 검사 |

통합 검증은 PostgreSQL 17 실행 파일이 있는 Docker 환경에서 실행합니다. 테스트는 임시 데이터와 서버 로그를 `build`에 두고 컨테이너 내부의 `127.0.0.1` 임시 TCP 포트로 접속합니다. 내장 fixture를 실행한 뒤 클러스터와 임시 디렉터리를 정리합니다. 루트로 시작된 컨테이너에서는 PostgreSQL 프로세스가 컨테이너의 `postgres` 사용자로 실행됩니다.

운영에서 `node dist/api/main.js`로 API를 실행하고 동일 origin에서 `dist/web` 정적 파일과 `/api`를 제공하도록 프록시를 구성합니다. API와 웹은 설치된 의존성을 사용합니다.

커밋한 편집과 실행 취소·다시 실행은 IndexedDB에 익명 로컬 복구본으로 저장됩니다. 저장 완료 후 새로고침하면 해당 복구본이 열립니다. 다른 탭의 저장이 앞섰으면 늦은 편집은 별도 복구본으로 남으며 탐색 패널에서 각 복구본을 열 수 있습니다. 저장·읽기가 실패하면 상단 상태에서 다시 시도할 수 있습니다.

## 진행 상태

- 1단계 개발 기반과 도메인 모델 완료. 당시 후보의 검증 근거는 `step-72`에 기록되어 있습니다. [1단계 구현 기록](docs/01-foundation-and-domain.md)
- 2단계 로컬 ERD 편집기 구현 후보. 호스트의 빌드·타입 검사·lint 및 두 Vitest 실행 결과를 기다립니다. 브라우저 테스트는 Docker 도구 구성에 포함된 Chromium을 사용합니다. 일반 개발 환경에서는 `CHROMIUM_PATH`에 설치한 Chromium 실행 파일을 지정할 수 있습니다. [2단계 구현 기록](docs/02-erd-editor.md)

인증과 서버 저장, DDL 가져오기·내보내기는 후속 단계입니다.

- [단계별 계획](docs/README.md)
- [PostgreSQL 지원 상태](docs/sql-support/postgresql.md)
