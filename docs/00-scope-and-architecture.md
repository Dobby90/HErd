# 공통 범위와 아키텍처

모든 구현 단계의 기준 문서다. 전체 순서는 [README](./README.md)를 따른다.

## 1. 제품과 초기 범위

사용자는 프로젝트 안에 여러 ERD 문서를 만들고, 테이블·컬럼·키·관계를 편집하며, PostgreSQL DDL을 가져오고 내보낸다. 문서 하나는 하나의 물리 데이터베이스 모델과 여러 다이어그램 뷰를 가진다. 같은 테이블을 여러 뷰에서 재사용할 수 있지만 문서 간 테이블 공유는 초기 범위에 없다.

| 구분 | 범위 |
| --- | --- |
| 초기 SQL 지원 | 인증한 PostgreSQL 메이저 버전과 명시된 구문 집합 |
| 기본 편집 정보 | 물리명·논리명·설명, 테이블·컬럼·키·인덱스·관계, 메모·그룹 |
| 저장 | 서버 자동 저장, 수동 스냅샷, 브라우저 임시 복구 |
| 협업 | 프로젝트 멤버의 owner/editor/viewer 권한, 저장 충돌 감지 |
| 출력 | 생성 SQL, PNG·SVG |
| 제외 | 외부 ERD 파일 호환, 자체 JSON 파일 입출력, 실시간 공동 편집, DB 직접 접속·DDL 실행, 변경분 마이그레이션 SQL, DBMS 자동 변환 |

서비스 저장소의 PostgreSQL 버전과 사용자가 설계하는 ERD의 PostgreSQL 버전은 독립적이다. 첫 SQL 인증 버전은 1단계에서 파서·실행 검증 결과로 고정한다. 우선 후보는 PostgreSQL 17·18이며 둘 다 지원한다고 미리 표시하지 않는다.

## 2. 기본 기술 구성

| 계층 | 기본안 | 목적 |
| --- | --- | --- |
| 언어 | TypeScript, ESM | 웹·API·공통 모델 타입 공유 |
| 웹 | React + Vite | 로그인·프로젝트 화면·클라이언트 편집기 |
| ERD 화면 | React Flow | 테이블 노드·컬럼 연결점·관계선·캔버스 조작 |
| 상태 | Zustand 등 작은 외부 스토어 | 문서 상태·명령·임시 화면 상태 분리 |
| API | Node.js + Fastify | 인증, 프로젝트, 문서, SQL 처리 |
| 저장소 | PostgreSQL + 명시적 DB 마이그레이션 | 메타데이터·JSONB 문서·이력 |
| 입력 검증 | 공유 런타임 스키마, 예: Zod | API와 문서의 형태 검증 |
| 테스트 | Vitest, Playwright, 테스트용 PostgreSQL | 도메인·SQL·주요 사용자 흐름 검증 |
| 개발 환경 | pnpm workspaces, Docker Compose | 패키지 경계와 재현 가능한 실행 |

Node.js·패키지 버전은 1단계 착수 시 호환성을 확인해 고정하고 lockfile을 커밋한다. 현재 문서의 후보 라이브러리가 특정 PostgreSQL 버전까지 지원한다는 가정은 하지 않는다. 초기에는 API 하나와 서비스 DB 하나로 구성하며 Redis·메시지 큐·마이크로서비스는 도입하지 않는다.

## 3. 권장 디렉터리와 의존 방향

```text
apps/
  web/                    React 앱, React Flow 렌더러
  api/                    Fastify, 인증·권한·저장·SQL API
packages/
  model/                  문서 타입·스키마·명령·참조 검증·형식 마이그레이션
  sql-contract/           dialect 인터페이스·지원 수준·진단·버전 계약
  sql-service/            registry 기반 SQL 작업 조율
  dialect-postgresql/     PostgreSQL 타입·검증·파서·생성기·지원 명세
  test-fixtures/          ERD 문서·DDL·의미 비교용 정규화 fixture
docs/
```

의존 방향은 `model ← sql-contract ← dialect-*`와 `model + sql-contract ← sql-service`다. 앱의 구성 지점에서 dialect를 registry에 등록한다. `model`은 React, Fastify, SQL 파서에 의존하지 않는다. 공통 `sql-service`도 PostgreSQL 패키지를 직접 import하지 않는다. 파서의 AST는 dialect 패키지 밖으로 노출하지 않는다.

웹은 등록된 dialect의 메타데이터·타입·capability를 사용한다. 무거운 파서는 API에서 실행하고 웹 번들에 포함시키지 않는다. UI용 모듈과 서버용 모듈의 entry point를 분리한다. 테스트에서 SQL 코어를 직접 호출할 수 있어야 한다.

## 4. 문서 모델

`ErdDocument`의 기본 구성은 다음과 같다. 식별자는 안정적인 내부 ID이며 이름을 바꿔도 참조가 유지되어야 한다.

| 필드 | 의미 |
| --- | --- |
| `formatVersion` | 자체 문서 구조 버전. DBMS 버전과 다름 |
| `id`, `name` | 문서 식별자·제목 |
| `target` | `{ dialectId, engineVersion }`, 문서당 하나의 물리 SQL 대상 |
| `catalog` | namespace, table, column, constraint, index, enum type, sequence |
| `relationships` | FK와 별개인 논리 관계. 실제 FK 연결은 constraint에서 도출 |
| `views` | 테이블 인스턴스·좌표·그룹·메모·표시 옵션 |
| `extensions` | dialect별 명시적 확장 데이터. namespace와 자체 버전 포함 |

핵심 규칙:

- 하나의 테이블 정의를 여러 뷰가 ID로 참조한다. 뷰에서 숨기기는 테이블 삭제와 구분한다.
- PK·UNIQUE·FK는 제약 객체가 원본이다. 컬럼의 PK/FK 배지는 파생 상태로 만들고 별도 boolean을 진실의 원본으로 저장하지 않는다.
- 복합키의 컬럼 순서와 복합 FK의 원본·대상 컬럼 대응을 보존한다.
- FK는 참조하는 PK·UNIQUE 제약 또는 dialect가 참조를 허용하는 고유 인덱스와 컬럼 목록을 식별한다. 일반 인덱스·고유 인덱스·UNIQUE 제약을 구분한다.
- 논리적 1:N 선은 자동으로 FK를 만들지 않는다. FK 만들기 명령은 참조 가능 키와 자료형을 검증한다. M:N의 물리 구현은 연결 테이블을 사용한다.
- 물리명은 namespace와 실제 식별자 값으로 분리한다. SQL의 대소문자·인용 규칙은 dialect가 해석한다. 원문 표기 여부는 부가정보로 보존할 수 있다.
- 데이터 타입은 단순 공통 enum으로 축소하지 않는다. 타입 참조·인수·배열 차원·원문 타입·dialect 확장을 담을 수 있는 descriptor를 사용한다. 공통 분류는 UI용이며 SQL 생성의 원본이 아니다.
- DEFAULT·CHECK·식 인덱스 등 SQL 표현식은 `{ dialectId, engineVersion, sql }`와 가능한 참조 정보를 가진 값으로 저장한다. 식별자 이름 바꾸기 시 정확한 재작성 근거가 없으면 무효화 진단을 내고 export를 차단한다. 문자열 치환으로 식을 고치지 않는다.
- enum·sequence 등 보조 객체는 관계선으로 그리지 않아도 catalog에서 보존한다. 지원 불가 객체는 누락 경고로 처리한다.
- vendor AST를 공통 문서에 그대로 저장하지 않는다. 필요한 dialect 속성은 버전 있는 확장 스키마로 정의한다.

형태 검증, 참조 무결성 검증, dialect 의미 검증을 분리한다. 작성 중인 불완전한 모델도 저장할 수 있지만 중복 ID·깨진 내부 참조 같은 구조 오류는 커밋할 수 없다. SQL 생성은 의미 오류까지 없어야 한다.

## 5. SQL 확장 계약

아래 이름은 구현 계약의 초안이다. 1단계에서 구체 타입을 정하고 이후 단계에서 함께 사용한다.

```ts
interface SqlDialect {
  metadata: DialectMetadata;
  capabilities(target: SqlTarget): DialectCapabilities;
  validate(document: ErdDocument, context: ValidationContext): Diagnostic[];
  parse(request: ParseRequest): Promise<ParseResult>;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}
```

| 계약 | 요구사항 |
| --- | --- |
| `DialectMetadata` | 안정적인 ID, 표시명, adapter 버전, 실제 인증한 엔진 버전·상태 |
| `DialectCapabilities` | 객체·기능별 `model/edit/import/export` 지원 수준. import 가능과 export 가능을 분리 |
| `ParseRequest` | SQL·명시적 대상 버전·기본 namespace·입력 제한·취소 신호 |
| `ParseResult` | 변환 후보 catalog·문장별 처리 결과·진단·인증 프로파일·손실 요약. 기존 문서 직접 수정 금지 |
| `GenerateRequest` | 문서·대상 버전·대상 테이블 선택·출력 옵션 |
| `GenerateResult` | SQL 또는 차단 상태, 진단, 필요한 의존 객체 목록. 오류가 있으면 다운로드 가능한 SQL을 반환하지 않음 |
| `Diagnostic` | 안정적 코드·심각도·기능·설명·object ID·원본 위치·해결 안내. 원문이 없으면 위치 생략 |

registry는 ID로 adapter를 찾는다. 미등록 dialect나 미인증 버전은 진단을 반환한다. PostgreSQL 파서·타입 변환·인용 처리·생성 로직을 공통 editor 컴포넌트에 넣지 않는다. 새 dialect는 전용 패키지, 등록 코드, 지원 명세·fixture 추가를 중심으로 확장되어야 한다.

기능이 아직 구현되지 않은 단계에서는 `not-implemented` 결과를 반환한다. 빈 SQL이나 빈 catalog를 성공으로 반환하지 않는다. capability와 실제 구현·테스트가 어긋나면 완료 처리하지 않는다.

## 6. 변환과 데이터 보존 정책

1. 한 문서의 target은 하나다. target을 바꾸는 행위는 단순 설정 변경이 아니다. 초기 UI는 문서 생성 시 결정하고 변경하지 않는다.
2. PostgreSQL → 다른 DBMS 자동 변환은 이 계획의 범위 밖이다. 추후 별도 conversion 서비스가 타입·표현식·손실 보고를 다루도록 확장 지점을 남긴다.
3. import의 성공은 지원한 의미 정보의 변환 성공이다. 파서가 SQL을 읽었다는 이유만으로 완전 지원을 주장하지 않는다.
4. 미지원 문장은 원문 위치·이유를 보고한다. 사용자가 손실을 확인한 경우에만 지원 부분을 적용할 수 있다. 구문 오류·모순·해결 못 한 의존 관계는 적용을 차단한다.
5. 원문 SQL은 import 작업의 임시 분석 자료다. 미지원 원문을 내보낼 SQL 뒤에 자동으로 붙이지 않는다. 이름 변경·의존성 변경 후 잘못된 SQL이 될 수 있기 때문이다.
6. export는 선택 범위 내 보존할 수 없는 의미가 있으면 차단한다. 명시적으로 지원하지 않는 기능을 몰래 생략하지 않는다.
7. 사용자 SQL을 서비스 DB나 사용자 DB에 실행하지 않는다. 생성 SQL의 실행 검증은 통제된 fixture와 격리한 테스트 DB에서만 한다.

## 7. 저장·변경 계약

- 서버 문서 envelope는 `{ document, revision, updatedAt }`다. `revision`은 서버가 관리하며 `formatVersion`이나 DBMS 버전과 혼용하지 않는다.
- 쓰기 요청은 `baseRevision`, `mutationId`, 전체 문서 payload를 가진다. revision 비교·증가와 저장은 같은 트랜잭션에서 실행한다.
- 다른 요청이 먼저 저장했으면 `409 REVISION_CONFLICT`를 반환한다. 자동 덮어쓰기·자동 병합은 하지 않는다.
- 같은 `mutationId`·같은 payload 재시도는 재적용하지 않는다. 동일 ID의 다른 payload는 거부한다. 성공 결과를 저장해 재시도 시 원래 성공 응답을 복구한다.
- 수동 스냅샷·import 교체·복원 이전의 문서를 이력에 보존한다. 자동 저장마다 전체 이력을 무제한 쌓지 않는다.
- undo/redo는 현재 편집 세션의 명령 이력이고, 서버 버전 복원은 영구 이력이다.
- 브라우저 복구 데이터는 사용자·문서·기준 리비전에 연결한다. 서버 문서와 다르면 자동 덮어쓰기하지 않는다.

## 8. 공통 검증과 용량 기준

의미 비교는 이름·namespace·자료형·기본값·키·제약·인덱스·설명·보조 객체를 정규화해 수행한다. 내부 ID·좌표·정렬·원문 공백은 DDL 비교 대상에서 제외한다. 지원 범위별 비교 규칙과 제외 근거를 명시한다.

초기 입력 한도는 SQL 5 MiB, 문서 JSON 20 MiB, 테이블 1,000개, 컬럼 총 20,000개, 관계 5,000개를 구성 가능한 상한으로 둔다. 이는 원활한 편집을 보장하는 성능 수치가 아니다. SQL 작업은 기본 10초·결과 보관 10분을 출발점으로 실제 측정 후 조정한다. 작업의 서버 실행을 중단할 수 있는 격리 worker를 사용한다.

7단계에서 일반 모델 100개 테이블·2,000개 컬럼·150개 FK와 큰 모델 300개 테이블·6,000개 컬럼·600개 FK를 측정한다. 장비·브라우저·빌드 모드를 기록하며 데이터 보존과 응답성을 함께 확인한다.

## 9. 참고 자료

- [React Flow 사용자 정의 노드](https://reactflow.dev/learn/customization/custom-nodes): 테이블 렌더러를 만들 수 있는 UI 확장 기능.
- [React Flow 성능 지침](https://reactflow.dev/learn/advanced-use/performance): 불필요한 재렌더와 큰 그래프 처리 시 고려사항.
- [libpg_query](https://github.com/pganalyze/libpg_query): PostgreSQL 서버 파서 소스를 사용하는 SQL 파싱 기반.
- [pgsql-parser](https://github.com/constructive-io/pgsql-parser): Node.js 파서 후보. 실제 채택 버전의 엔진 지원 범위 검증 필요.
- [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html): 스키마 덤프의 SQL·아카이브 형식과 옵션.
- [openid-client](https://github.com/panva/openid-client): 서버 OIDC 인증 연동 후보.

자료 확인일: 2026-11-18. 구현 시 사용 버전과 인증 결과를 별도로 기록한다.
