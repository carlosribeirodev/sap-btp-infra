# Segurança e acesso

Este é um exercício público. Versionar apenas código, dados sintéticos e exemplos
de configuração. Arquivos reais de destino CF, credenciais, bindings, certificados,
tokens e logs operacionais ficam fora do checkout. O .gitignore ajuda a evitar
staging acidental e não substitui revisão do diff.

O CI usa runners hospedados, actions fixadas por SHA, `contents: read` e checkout
sem credenciais persistidas. Ele não recebe secrets BTP nem executa código de PR
com autenticação da plataforma. Não usar `pull_request_target` para executar o
conteúdo de uma PR com credenciais. Workflows de PRs externas podem depender da
aprovação do mantenedor para começar a rodar.

Write é concedido somente a desenvolvedores autorizados. Essa permissão permite
alterar branches e workflows; o futuro deploy precisa de um environment protegido
restrito a main e de regras próprias para liberar credenciais. Main exige CI e
aprovação de CODEOWNER inclusive para administradores. CODEOWNERS ajuda a controlar
revisão; ele não autentica o operador nem o usuário que roda os scripts localmente.

O provisionador usa autenticação CF de um operador e executa tasks temporárias.
`apply` usa acesso administrativo SQL e acesso ao cofre para os apps do catálogo.
Os checks usam bindings restritos ao runtime de um app. As senhas SQL são geradas
na task e gravadas no SAP Credential Store; não são exportadas para o GitHub.

Não inclua segredos em issues ou PRs. Relate vulnerabilidades ao mantenedor sem
publicar credenciais ou dados do ambiente. Revogação e rotação devem ocorrer no
provedor; remover um arquivo do Git não revoga um segredo já exposto.
