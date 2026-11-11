# Provisionador PostgreSQL por catálogo e revisão de PR

Requests e Assets declaram suas necessidades em arquivos JSON. O provisionador
valida o catálogo, prepara os serviços compartilhados e cria uma alocação isolada
por app. O código dos apps continua no repositório público existente.

## Interface de execução

| Comando | Efeito |
| --- | --- |
| `plan` | Valida o catálogo e imprime o plano, sem ler login ou acessar o BTP. |
| `bootstrap --target ...` | Cria ou aguarda PostgreSQL e Credential Store gerenciados por este provisionador. |
| `apply --target ...` | Provisiona bancos/schemas/usuários/cofre dentro de uma task CF e executa as verificações de runtime. |
| `check --target ...` | Verifica cada app com um binding que lê somente seu segredo de runtime. Cria/remove tasks temporárias. |

Não há comando de exclusão. Remover um arquivo do catálogo preserva os recursos
já existentes. `apply` não publica APIs CAP, executa migrações de negócio ou cria
XSUAA. Essas operações pertencem à entrega da aplicação.

## Preparação local

Python 3.10+, Node.js 24 e CF CLI v8. Dependências fixadas em `requirements.txt` e
`worker/package-lock.json`. Usar um virtualenv dedicado quando necessário.

```sh
cd infrastructure/postgres
python3 -m pip install -r requirements.txt
npm --prefix worker ci --ignore-scripts
python3 provision.py plan
```

O worker usa somente `pg` e os módulos nativos de Node.js para o cliente do cofre.
O bundle enviado ao CF contém código, lockfile e plano sem segredos. Não contém
`node_modules`, credenciais SQL, service keys ou o perfil de login CF.

## Configurar o destino e executar no BTP

Copiar `platform/target.example.json` para um arquivo privado fora do Git. Preencher
API e org; o MVP usa o space `dev`. O arquivo real deve ficar fora do checkout. Ele contém somente o destino e os
planos, não senhas.

```sh
cf login --sso
cf target -o YOUR_ORG -s dev

python3 provision.py bootstrap --target /path/to/private/target.json
python3 provision.py apply --target /path/to/private/target.json
python3 provision.py check --target /path/to/private/target.json
```

**Os três últimos comandos fazem operações reais no BTP.** Eles validam o destino
local e remoto antes de qualquer mutação. O MVP aceita exatamente:

- `cap-lab-dev-postgres`: `postgresql-db`, plano `trial`, PostgreSQL 16.
- `cap-lab-dev-credentials`: `credstore`, plano `trial`, autenticação mTLS.

A ausência de plano/entitlement resulta em erro; não existe fallback para plano
pago. A disponibilidade do trial depende da conta/região. Serviços preexistentes
sem os labels `managed_by=cap-postgres-catalog-v1` e `profile=shared-dev`, ou com
plano/offering diferente, são recusados, mesmo quando o nome coincide.

A conta CF precisa criar serviços/apps/tasks/bindings no space. O usuário SQL do
binding gerenciado precisa criar bancos e roles e administrar as roles que cria.
O cofre precisa aceitar quatro namespaces e as credenciais correspondentes; durante
as verificações, só uma task usa o binding temporário por vez.

## Contrato e políticas

| Caminho | Responsabilidade |
| --- | --- |
| `catalog/dev/<app_id>.json` | Pedido: app, proprietário, ambiente, perfil, pool e retenção. |
| `schemas/request.schema.json` | Formato estrito do pedido. |
| `platform/registry.json` | Registro da plataforma: apps, repos, diretórios e perfis aprovados. |
| `platform/target.example.json` | Formato do destino e perfil inicial de serviços. |
| `validate_catalog.py` | Validação local e derivação de nomes. |
| `provision.py`, `cf_platform.py` | Interface e execução de tasks no CF. |
| `worker/` | Provisionamento SQL, cliente do cofre e verificação de runtime. |

O pedido não aceita senhas, SQL, repositórios escolhidos pelo solicitante ou nomes
arbitrários de bancos, usuários e namespaces. Nome do arquivo, app e ambiente devem
coincidir. A associação ao repositório vem do registro da plataforma.

O perfil `shared-dev` usa banco lógico por app, schema privado, login de deployer e
login de runtime. O pool declarado é um limite por processo, não uma quota rígida
de servidor; dimensionar réplicas e tasks continua sendo responsabilidade da
plataforma. O provisionador não altera o pool dos apps, que ainda serão publicados.

## Estado, concorrência e retomada

O progresso fica em `cap_catalog.allocations`, no banco de manutenção informado
pelo binding gerenciado. O registro guarda identidade, fases e OIDs, sem senhas.
Um advisory lock nesse mesmo banco impede dois provisionadores simultâneos.

1. A alocação é reservada somente se não houver recursos SQL/cofre sem registro.
2. As senhas aleatórias são gravadas no cofre como `prepared`, antes de criar roles.
3. Criação das duas roles e registro dos seus OIDs fazem parte da mesma transação.
4. O banco nasce com conexões desabilitadas. Antes de habilitá-las, o provisionador
   remove os privilégios de `PUBLIC` e concede somente os acessos necessários.
5. Schema, grants existentes e privilégios padrão são preparados. O runtime recebe
   CRUD e uso de sequences, sem CREATE persistente ou privilégios administrativos.
6. Uma tabela de teste verifica CRUD real e sequences; depois é removida. O prefixo
   `__catalog_` é reservado. Um probe interrompido só é removido quando tem o marker
   de propriedade esperado; uma tabela sem esse marker provoca conflito.
7. As conexões são verificadas antes de publicar credenciais `ready`. Ao final,
   o provisionador verifica a recusa de conexão entre os bancos declarados.

Reexecutar `apply` reutiliza as senhas existentes e preserva tabelas de negócio.
Uma falha após escrever o cofre, criar roles, criar banco ou publicar uma das
credenciais pode ser retomada pelo mesmo comando. Credenciais perdidas após a
criação das roles, OIDs/proprietários divergentes, mudança de identidade e roles
com privilégios inesperados interrompem a operação. Não há adoção silenciosa,
reset automático de senha, troca de proprietário ou recriação de banco perdido.

As gravações do cofre usam `If-None-Match: *` para criar e `If-Match: *` para atualizar.
O lock serializa as operações deste provisionador; essas condições não substituem
controle de acesso contra outros escritores autorizados. A conexão ao PostgreSQL
usa TLS com validação de certificado; o cofre usa mTLS e payload JWE. As senhas
ficam no cofre e na memória da task. Na criação SQL é enviado um verificador SCRAM,
que também deve ser tratado como sensível nos logs administrativos do servidor.

## Operação e recuperação

A task `apply` recebe o binding administrativo do PostgreSQL e acesso aos namespaces
do catálogo. Cada task `check` recebe somente o namespace de runtime de um app,
sem binding administrativo. O check confirma recusa de DDL, acesso cruzado SQL e
leitura de outros segredos. A tarefa é acompanhada pela API até SUCCEEDED; o retorno
zero da CLI sozinho não é considerado sucesso.

Tasks/apps temporários são removidos em `finally`, inclusive quando staging ou SQL
falham. Uma interrupção externa que mate também o processo controlador pode deixar
um app `cap-catalog-*` e bindings no CF. Nesse caso, conferir se há task ativa e
remover somente o app temporário correspondente antes de repetir, especialmente
quando a quota de bindings do trial estiver ocupada. O estado SQL/cofre é preservado.
Falha de limpeza é reportada, não tratada como sucesso.

O `bootstrap` não altera parâmetros de serviços existentes. Rotação de senha,
renovação de bindings/certificados, mudança de plano, instância, repo/proprietário ou
nomes SQL são operações separadas, ainda sem automação neste MVP. Os serviços e
alocações de apps removidos do catálogo permanecem retidos.

## Testes

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/credential-store.test.cjs
python3 tests/run_integration.py --pg-bin /path/to/postgresql16/bin
```

`run_integration.py` inicia um cluster efêmero em 127.0.0.1 com porta aleatória e o
remove ao terminar. Não recebe conexão existente ou credenciais BTP. Os testes usam
um provisionador SQL sem SUPERUSER e um cofre em memória; os testes do cliente do
cofre verificam JWE, mTLS/configuração e headers condicionais com transporte simulado.
Eles não substituem a validação dos bindings e brokers reais no BTP.

Evidências e limites da execução: [VALIDATION.md](VALIDATION.md).

## GitHub Actions — CI sem deploy

O workflow [`postgres-catalog-ci.yml`](../../.github/workflows/postgres-catalog-ci.yml)
executa `plan` e os 39 testes em PRs para main, pushes para main e acionamento
manual. O PostgreSQL de integração é efêmero e local ao runner; o job não recebe
secrets BTP nem executa os comandos de nuvem.

Este repositório é público. Colaboradores com permissão Write usam clone, branch,
push e PR; o fork é opcional. A branch main exige o check do CI e uma aprovação de
CODEOWNER para não administradores. Admins podem dispensar revisão ao mesclar
uma PR, inclusive própria, depois do CI obrigatório. O GitHub continua recusando
aprovação formal pelo próprio autor. A exceção não permite push direto ou bypass
do CI; ver [governança](../../docs/governance.md).

O merge executa apenas CI. A entrega após merge depende da futura identidade
técnica e de um workflow separado. O deploy dos apps ainda precisa ser adaptado.

Configuração e preparo da entrega estão em [CI.md](CI.md). Para solicitar uma nova
alocação, seguir o [guia de contribuição](../../CONTRIBUTING.md).

O registro, schemas, scripts e workflows precisam de revisão da plataforma. O
validador confere conteúdo; não autentica quem o executa. A pipeline deve obter o
repo e o ambiente de contexto confiável. Quem pode criar bindings amplos ou
publicar código arbitrário em produção continua capaz de usar esses acessos.
