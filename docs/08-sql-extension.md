# 8단계 — SQL 구문·DBMS 확장

선행 조건: [7단계](./07-hardening-and-release.md) 완료 또는 동일 수준의 기존 SQL 회귀 검증 확보. [공통 아키텍처](./00-scope-and-architecture.md)의 dialect 계약을 유지한다.

## 목표와 진입 조건

이 단계는 다음 두 종류의 후속 요청에 재사용한다.

- A: PostgreSQL의 지원 구문·객체 또는 인증 엔진 버전을 추가한다.
- B: MySQL·MariaDB·SQL Server 등 다른 SQL dialect를 추가한다.

개발 요청에서 대상 DBMS·메이저 버전·필수 기능이 지정되어야 한다. 정해지지 않았다면 우선 그 범위를 확인하고 기존 구조·fixture 조사까지 진행한다. 이 문서만으로 임의의 새 DBMS를 지원 완료로 표시하지 않는다. 한 번의 요청에서는 한 대상과 검증 가능한 기능 집합으로 범위를 제한한다.

DBMS 간 자동 변환, 기존 ERD의 target 변경, 외부 ERD 파일 호환은 이 단계에도 포함하지 않는다. 다른 DBMS의 새 문서를 만들거나 해당 DBMS DDL을 가져오는 기능이다.

## 확장 요청에 포함할 정보

| 항목 | 예시 | 필요한 이유 |
| --- | --- | --- |
| 확장 유형 | PostgreSQL 구문 추가 / 새 DBMS | 기존 adapter 수정인지 신규 package인지 결정 |
| 엔진·버전 | PostgreSQL의 특정 메이저 / MySQL의 특정 메이저 | 문법·동작·제약 차이 인증 |
| 객체·기능 | partial index, generated column, 특정 자료형 | 지원 범위를 테스트 가능한 단위로 한정 |
| 처리 방향 | model/edit/import/export 중 필요한 범위 | 화면 표시와 의미 보존을 따로 판정 |
| 입력 근거 | 비식별 DDL, 공식 문서, DB fixture | 실제 사용하는 구문과 경계 사례 확보 |

예시는 선택 기준이며 현재 추가하기로 확정한 기능 목록이 아니다.

## A. 같은 DBMS의 SQL 기능·버전 확장

### 1. 지원 분석

- 공식 문서와 통제된 DB fixture로 문법·의미·버전 차이를 확인한다.
- 이미 parse 가능한 구문이라도 현재 모델·UI·generator가 보존할 수 있는지 각각 평가한다.
- 파서 버전만 올려 지원 완료로 처리하지 않는다. AST 구조 변경과 기존 입력의 처리 차이를 점검한다.
- 새 엔진 버전은 별도 인증 대상으로 추가한다. 예전 버전의 capability를 새 버전에 그대로 복사하지 않는다.

### 2. 모델과 adapter 확장

- 기존 공통 개념으로 충분하면 PostgreSQL extension의 버전 있는 속성으로 추가한다.
- 여러 dialect에 공통인 새 개념이면 공통 모델을 확장할 수 있다. 기존 문서가 손실 없이 읽히도록 순차 마이그레이션과 fixture를 함께 추가한다.
- 예를 들어 partial/expression index를 추가할 때 predicate·표현식·참조·인용·이름 변경의 동작까지 정의한다. raw SQL 문자열 하나를 붙여놓고 편집 지원으로 표시하지 않는다.
- parse·validate·generate·capability·지원 명세를 함께 수정한다. 일부 방향만 지원하면 UI와 결과에 그 상태를 그대로 노출한다.
- 새 표현식의 이름 변경·삭제 동작이 불확실하면 검토 필요 진단을 남기고 export를 차단한다.

### 3. 인증

- 새 기능의 모델→SQL→모델과 통제된 DB 실행·catalog 비교를 추가한다.
- 해당 기능을 지원하지 않는 엔진 버전에서 명확히 차단하는 테스트를 추가한다.
- 기존 fixture의 의미와 이전 문서·snapshot 마이그레이션이 유지되는지 확인한다.

## B. 새 SQL dialect 추가

### 1. 구조와 등록

- `packages/dialect-<id>/`를 만들고 메타데이터·타입·capability·검증·파서·생성기를 구현한다.
- 앱의 구성 지점에서 registry에 등록하고 인증 대상·버전을 노출한다.
- SQL job·저장 API·React Flow 테이블 렌더러는 그대로 사용한다. 이 계층들에 `if mysql`, `if mssql` 같은 분기문을 퍼뜨리지 않는다.
- DBMS별 추가 편집 필드는 등록된 메타데이터와 제한된 확장 패널로 제공한다. 핵심 UI가 vendor AST를 알아야 하는 구조를 만들지 않는다.

### 2. 타입·이름·객체 매핑

- 대상 DBMS의 namespace/catalog 구분, 이름 해석·대소문자·인용, 제약 이름 범위를 공식 동작에 맞춰 구현한다.
- 자료형을 해당 dialect의 descriptor로 유지한다. PostgreSQL 타입으로 저장해두었다가 출력 때만 문자열을 바꾸지 않는다.
- 자동 번호·default·inline enum·table options·index method·comment·참조 동작 등 차이를 독립 기능으로 정의한다.
- MySQL을 선택한 경우 unsigned·AUTO_INCREMENT·engine/charset/collation·inline enum처럼 PostgreSQL과 다른 속성을 검토한다. 다른 엔진을 선택하면 해당 엔진의 차이를 기준으로 한다.
- 공통 모델의 기본값·확장이 특정 PostgreSQL 의미를 몰래 강제하는 부분이 있는지 확인한다. 필요하면 호환 마이그레이션으로 모델을 개선한다.

### 3. SQL 처리와 작업 연결

- 대상 DBMS를 실제로 읽을 수 있는 파서를 선택하고 DDL fixture로 검증한다. 파서의 지원 DBMS 목록만 믿고 채택하지 않는다.
- 분석 작업과 생성 작업은 같은 `SqlDialect` 계약·진단·timeout·TTL·권한 규칙을 사용한다.
- 새 문서 생성 시 해당 dialect를 고를 수 있게 한다. 저장된 target과 실제 adapter가 다르면 변환하지 않고 차단한다.
- 이미 존재하는 PostgreSQL 문서는 target·타입·SQL 결과를 그대로 유지한다.
- export와 import를 모두 구현·인증한 뒤 해당 방향 capability를 활성화한다. 출시가 나뉘면 구현한 방향만 활성화한다.

### 4. 검증

- 해당 DBMS의 통제된 스키마·덤프·모델 fixture를 추가한다.
- 생성 SQL을 격리한 대상 DB에서 실행해 catalog 의미를 확인한다.
- 모델→SQL→모델의 동등성은 해당 dialect의 규칙으로 정규화한다. 다른 dialect와 문자열이 같아야 한다는 테스트를 만들지 않는다.
- reserved word·인용 이름·복합키·자기/순환 FK·default·자동 번호·comment·미지원 속성을 확인한다.
- 기존 PostgreSQL SQL·API·저장·공유 흐름의 회귀 검증을 실행한다.

## 검증과 확장 구조의 합격 기준

다음 변경은 정상적인 확장이다.

- dialect package 내부 구현, 구성 지점 등록, 지원 명세·fixture 추가.
- 실제로 필요한 공통 모델의 호환 가능한 확장과 문서 마이그레이션.
- capability가 설명하는 새 필드와 재사용 가능한 편집 요소 추가.

다음 변경이 필요해지면 구현을 끝내기 전에 경계를 보완한다.

- 프로젝트 저장 API가 DBMS마다 다른 문서 payload를 처리한다.
- React Flow 노드가 SQL 구문·vendor AST를 직접 조작한다.
- 다른 DBMS 타입을 PostgreSQL 타입으로 손실 변환해 저장한다.
- 새 기능 때문에 기존 SQL 생성 결과에서 제약·타입 속성이 사라진다.
- 파서·registry가 모든 DBMS 패키지를 웹 번들에 포함시킨다.

## 완료 기준

- [ ] 대상·버전·기능·처리 방향을 명시했다.
- [ ] adapter와 capability·UI 상태·지원 명세가 일치한다.
- [ ] 새 fixture의 의미 보존·DB 실행·진단 검증이 통과한다.
- [ ] 모델 변경 시 문서·이력 마이그레이션을 검증했다.
- [ ] 기존 PostgreSQL 지원이 퇴행하지 않았다.
- [ ] DBMS 자동 변환·외부 ERD 파일 호환을 범위에 섞지 않았다.
- [ ] `docs/sql-support/<dialect>.md`와 release 검증 기록을 갱신했다.

## 개발 요청 예시

> docs/README.md와 docs/00-scope-and-architecture.md를 읽고, docs/08-sql-extension.md의 A 경로로 PostgreSQL [버전]의 [기능]을 확장해줘. 필요한 model/edit/import/export 범위는 [범위]이고 기존 PostgreSQL 지원의 회귀도 검증해줘.

> docs/README.md와 docs/00-scope-and-architecture.md를 읽고, docs/08-sql-extension.md의 B 경로로 [DBMS·버전]의 [필수 기능]을 추가해줘. 공통 저장·SQL 작업 계약을 유지하고 해당 엔진의 실제 의미 검증을 수행해줘.

구현 기록: 미착수. 추가 SQL 기능·DBMS가 지정되었을 때 실행하는 선택 단계.
