# Arquitetura do exercício

Este repositório é a fonte do catálogo, das políticas, do provisionador e dos
testes. Os apps CAP ficam em um repositório próprio. Documentação operacional
privada e configurações reais de conta têm armazenamento separado.

| Responsável | Ação |
| --- | --- |
| Desenvolvedor autorizado | Cria branch, declara o pedido e abre PR. |
| Plataforma | Aprova registro do app, perfil e alterações de infraestrutura. |
| GitHub Actions | Valida o catálogo e testa o provisionador sem acesso ao BTP. |
| Operador CF | Aplica o catálogo revisado e acompanha as verificações. |
| Aplicação | Usa uma credencial restrita ao seu banco/schema, na futura entrega. |

O perfil `shared-dev` compartilha a instância física e cria um banco lógico por app,
com schema próprio e usuários distintos para deployer e runtime. Namespaces do
Credential Store também são separados. O runtime recebe CRUD e sequences, sem
CREATE persistente ou acesso ao banco de outro app.

O comando `bootstrap` prepara os dois serviços físicos; `apply` cria/reutiliza as
alocações e executa verificações. `check` usa somente bindings de runtime restritos.
O plano offline deriva nomes, sem consultar drift ou estimar custo do ambiente.

O estado de provisionamento fica no PostgreSQL, sem senhas. Um advisory lock
serializa operações na mesma instância; todas precisam usar o mesmo banco de
manutenção. O processo é retomável e recusa recursos preexistentes sem registro,
trocas de identidade e privilégios inesperados. Remoção de catálogo retém dados.

O merge dispara CI; a entrega automática e o deploy dos apps ainda serão
implementados. A etapa futura precisa usar identidade técnica, environment
protegido e workflow de entrega separado. Publicar o código não concede acesso
ao ambiente BTP do mantenedor.
