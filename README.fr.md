# PPTimistic

**Des présentations PowerPoint modifiables, construites à partir des objectifs du créateur et de sources traçables.**

PPTimistic est un outil local, utilisable avec un agent de programmation ou un terminal. Texte, formes, schémas, notes et graphiques pris en charge restent modifiables. Aucun compte, service payant ni clé API n'est requis.

[English](README.md) · [Initialisation et validation du brief](docs/onboarding.md) · [Guide complet](docs/workflows.md) · [Limites](docs/limitations.md)

![Studio collaboratif PPTimistic](docs/studio-preview.png)

## Démarrer une véritable présentation

**Prérequis :** Node.js 22.13 ou ultérieur, avec npm. Vous pouvez [créer un dépôt à partir du modèle](https://github.com/new?template_name=PPTimystic&template_owner=dhuzard), ou cloner le [dépôt source](https://github.com/dhuzard/PPTimystic).

```sh
git clone https://github.com/dhuzard/PPTimystic.git
cd PPTimystic
npm install
npm run new -- --project mon-expose --inputs "chemin/vers/documents" --ui fr --no-render
```

En mode interactif, l'initialisation demande d'abord le titre, les langues et le style. Elle impose ensuite un **entretien de cadrage** portant sur le profil et les préférences du créateur, le but de l'exposé, le public et ses connaissances, le message principal, les conditions de présentation, les sources, les incertitudes, le ton, les visuels et les contraintes.

**Le créateur doit relire et approuver explicitement le brief avant toute génération PowerPoint.** Le brief validé est conservé dans `projects/mon-expose/presentation-brief.yaml`. Le fichier `presentation-brief.md` reste un espace de notes complémentaires : il ne constitue pas une validation.

Les documents importés sont conservés localement. Ils ne sont **pas automatiquement résumés** : le créateur ou son agent doit ensuite rédiger les diapositives dans `content/slides.yaml`, en respectant le brief et les preuves disponibles.

```sh
npm run brief -- --project mon-expose --check   # Vérifier le brief approuvé
npm run build -- --project mon-expose           # Créer le PPTX modifiable
npm run validate -- --project mon-expose        # Vérifier sources et sortie
npm run render -- --project mon-expose          # Aperçus facultatifs
npm run bundle -- --project mon-expose          # Préparer la livraison
```

Les fichiers PowerPoint sont produits dans `projects/mon-expose/output/`. Les contrôles automatiques ne remplacent pas la relecture scientifique, visuelle et éditoriale.

### Initialisation non interactive

L'option `--yes` **ne valide jamais le brief**. Elle crée un projet en brouillon, sans autoriser la construction ou l'export d'une véritable présentation.

```sh
npm run new -- --project mon-expose --yes --inputs "chemin/vers/documents" --no-render
npm run brief -- --project mon-expose --ui fr   # Entretien et approbation par le créateur
npm run brief -- --project mon-expose --check
```

Après une modification manuelle du fichier YAML, lancez `npm run brief -- --project mon-expose --approve --ui fr`. L'approbation est liée à une empreinte du contenu : toute modification pertinente nécessite une nouvelle confirmation. Un agent ne peut pas inférer cette approbation. Voir le [guide d'initialisation](docs/onboarding.md), en anglais, pour les règles détaillées.

## Explorer la démonstration fictive

```sh
npm run demo -- --project demo --no-render
npm run session -- --project demo --port 0
```

Cette démonstration bilingue contient cinq diapositives et des **données de graphiques fictives**. `npm run setup -- --yes`, sans documents source, permet également une démonstration non interactive. Utilisez `npm run new` pour créer une véritable présentation.

![Cinq diapositives fictives](docs/demo-contact-sheet.png)

## Produire le contenu et collaborer

L'import de fichiers PDF textuels, DOCX, Markdown/TXT et CSV conserve la provenance des sources. Il ne démontre ni l'exactitude des résultats ni la pertinence des affirmations. Un agent doit lire les documents, conserver les nuances et signaler les preuves manquantes.

Pour importer littéralement un plan Markdown (un seul fichier avec titres `##`), utilisez :

```sh
npm run new -- --project cours --yes --inputs "chemin/vers/plan" --from-plan --source fr-FR --locales fr-FR
npm run brief -- --project cours --ui fr
npm run build -- --project cours
```

La structure est préservée sans réécriture scientifique automatique. Les textes trop denses peuvent être rejetés lors de la validation.

Le studio collaboratif local est lancé par `npm run session -- --project mon-expose --port 0`. Il permet l'édition des objets, les commentaires, les révisions et l'export, **mais bloque l'export tant que le brief du projet réel n'est pas approuvé**. Aucun agent ou service externe n'est actif par défaut. Voir le [guide des sessions](docs/session.md).

La démarche éditoriale vise un message central par diapositive, appuyé sur des preuves adéquates et exprimé sans exagérer la causalité. Plusieurs éléments graphiques peuvent servir un même message. Les travaux de [Naegle (2021)](https://pmc.ncbi.nlm.nih.gov/articles/PMC8638955/), [Mayer (2020)](https://doi.org/10.1017/9781316941355) et [Sweller et al. (2019)](https://doi.org/10.1007/s10648-019-09465-5) éclairent ces choix ; ils ne démontrent pas que PPTimistic améliore lui-même l'apprentissage.

## Illustrations et traductions

Placez vos références visuelles dans `projects/<nom>/assets/reference/`. Demandez à l'agent de les examiner et d'adapter `illustration-style.md`. Aucune analyse automatique de style n'est annoncée. La commande `npm run images -- --project recherche` prépare les prompts et la provenance. Les schémas natifs fonctionnent sans service externe. Ajoutez une illustration locale avec `--slide S002 --asset "chemin/image.png"` ; remplacer une image acceptée demande également `--authorize S002`.

```sh
npm run translate -- --project recherche --to it-IT
# Complétez les objets translation du fichier YAML indiqué, puis :
npm run translate -- --project recherche --to it-IT --file "chemin/traductions.yaml"
npm run build -- --project recherche
```

Une traduction manquante bloque l'export de cette langue. Les nombres, unités, DOI et termes protégés du glossaire sont contrôlés. La fidélité scientifique doit être relue par une personne compétente.
Pour un graphique fictif dans une autre langue que le français ou l'anglais, renseignez `fictionalNotice` avec une mention explicite et relue dans cette langue ; sinon, la compilation s'arrête.

## Donner un retour

```sh
npm run revise -- --project recherche --slide S002 --message "Réduis le texte sans modifier le sens scientifique."
```

Le retour est consigné pour votre agent ; la commande ne prétend pas interpréter seule le langage naturel. Demandez ensuite : « Applique le retour sur S002, conserve les diapositives approuvées, puis reconstruis. » Les modifications de contenus approuvés ou verrouillés nécessitent une autorisation explicite. Les anciennes sorties sont conservées.

Les modifications effectuées directement dans PowerPoint **ne mettent pas à jour le YAML**. Un fichier PowerPoint modifié extérieurement n'est pas écrasé. Gardez une copie et demandez à l'agent de réconcilier les changements avec les sources avant de reconstruire.

Pour préparer une livraison locale, lancez `npm run bundle -- --project recherche`. La commande vérifie les PPTX et crée `output/deliveries/<id>/` avec les présentations, les résultats de validation et un manifeste d'empreintes. `--previews latest` ajoute les aperçus récents et vérifiés. Les documents originaux sont exclus, sauf si vous nommez chaque fichier avec `--input inputs/nom-du-fichier`. Vérifiez le dossier avant de le partager.

## Aperçus de l'intégration continue

GitHub Actions vérifie Node 22.13 et 24 sous Linux, macOS et Windows. Le job Linux avec Node 22.13 rend le jeu de diapositives typographiques public et conserve sept jours ses seules images d'aperçu et son `qa-manifest.json`. Le manifeste indique le moteur, la langue, le thème, les IDs et les images à examiner par une personne. CI ne prétend pas effectuer une inspection visuelle ni un test de lecteur d'écran.

## Aide

`npm run doctor` vérifie l'environnement. `npm run build -- --help` décrit les options. `npm run demo` reconstruit la démonstration existante sans remplacer son contenu. `npm run check` lance le contrôle TypeScript et les tests.

Les aperçus nécessitent LibreOffice avec `pdftoppm`, ou PowerPoint installé sous Windows. Configurez `SOFFICE_PATH` et `PDFTOPPM_PATH` si nécessaire. La commande render indique les outils locaux manquants ; le PPTX reste disponible. Si le dossier d'import est introuvable, vérifiez son chemin complet et indiquez le dossier contenant les fichiers. `--from-plan` demande un seul fichier Markdown avec des titres de diapositives `##`. L'assistant vérifie Node, les dépendances et les droits d'écriture avant de créer un projet ; `npm run doctor` détaille les prérequis à corriger. Arial est la police par défaut ; configurez Inter si elle est installée. Ne redistribuez pas de polices propriétaires. Les diagnostics et les commandes avancées restent principalement en anglais dans cette version.

Par défaut, la CLI traite les fichiers localement et n'effectue aucun appel réseau vers une IA. Un adaptateur d'agent explicitement configuré pour une session peut appeler un service externe. Un agent de programmation est un service distinct, soumis à ses propres règles de traitement des données : si vous en utilisez un, l'agent et ses outils connectés peuvent transmettre des documents sources, du texte extrait ou des prompts hors de votre ordinateur. Vérifiez sa configuration et ses règles, et ne lui confiez pas de données confidentielles sans avoir explicitement approuvé la destination et le périmètre. Aucun fournisseur d'IA ni agent réseau n'est activé par défaut.

Les projets privés sont exclus de Git par défaut, sauf les sources fictives de la démonstration. N'ajoutez pas de documents confidentiels ni de fichiers générés à un dépôt public. Voir [les parcours détaillés](docs/workflows.md), [le modèle de contenu](docs/architecture.md), [la confidentialité](docs/providers.md) et [les limites](docs/limitations.md). PPTimistic est un dépôt modèle indépendant. La CLI conserve les fichiers du projet localement sauf publication volontaire ; vérifiez séparément le traitement des données de l'agent si vous en utilisez un.

## Contribuer

Consultez [CONTRIBUTING.md](CONTRIBUTING.md) pour contribuer et [SECURITY.md](SECURITY.md) pour signaler un problème de sécurité. Le projet est distribué sous [licence MIT](LICENSE).
