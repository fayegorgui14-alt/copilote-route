# Copilote Route — notes de projet (pour reprendre le travail)

Propriétaire : Gorgui Faye (Dakar). Non technique : répondre en français, pas à pas, étapes numérotées, points de confirmation.

## Ce que fait l'application
Alerte anticollision sur téléphone Android (application web installable, PWA) :
détection des voitures, motos, camions, bus, vélos et piétons avec la caméra (TensorFlow.js, COCO-SSD lite, modèle dans `model/`),
alertes voix (français uniquement) + bip + vibration, enregistrement vidéo type dashcam (dans le téléphone uniquement),
GPS incrusté sur les vidéos, alerte d'excès de vitesse, démarrage automatique à l'ouverture.

## Hébergement
- Code : GitHub `fayegorgui14-alt/copilote-route`, branche `main`, publié par GitHub Pages
  → https://fayegorgui14-alt.github.io/copilote-route/
- Base de données : Supabase, projet `copilote-route` (référence `owjzyeiywdbkcavudxeu`, offre gratuite, région Europe).
  Clé publique (publishable) dans `config.js` — c'est normal, la sécurité vient des règles RLS.
  Ne jamais mettre de clé secrète (service_role, clés Wave/Orange Money) dans ce dépôt.
- « Confirm email » est désactivé dans Supabase Auth (comptes = numéro de téléphone + code à 6 chiffres,
  convertis en e-mail fictif `<numéro>@copilote-route.app`).

## Fichiers
- `index.html` : application conducteur (comptes, abonnement, paiement, copilote, vidéos, réglages)
- `account.js` : comptes, accès, file d'attente hors ligne des alertes/trajets
- `recorder.js` : enregistrement vidéo (IndexedDB), incrustation GPS
- `admin.html` : back-office administrateur (Gorgui = rôle admin, numéro 221773944916)
- `fleet.html` : espace entreprise (responsables de flotte)
- `supabase.sql` : schéma complet + règles de sécurité + fonctions (idempotent, déjà exécuté)
- `nav.js` : navigation (Leaflet dans `lib/leaflet/`, recherche Nominatim, itinéraire OSRM, guidage vocal FR).
  Serveurs réglables dans config.js (NAV_TILES, NAV_GEOCODER, NAV_ROUTER). Par défaut : serveurs publics gratuits,
  réservés aux essais → passer à un fournisseur (MapTiler, OpenRouteService, Geoapify…) avant de nombreux clients.
- `sw.js` : fonctionnement hors ligne — incrémenter `CACHE` (copilote-vN) à chaque publication

## Modèle économique
Essai 7 jours, puis 1 500 FCFA/mois (réglable dans le back-office). Paiement Wave / Orange Money
déclaré par le client puis validé à la main par l'admin. Abonnement flotte : prix par véhicule, code entreprise à 6 caractères.

## En pause
- Conditions d'utilisation (`conditions.html`, brouillon prêt mais non relié) et case d'acceptation à l'inscription
  (`CGU_OFF=true` dans index.html). À réactiver quand Gorgui fournit : nom d'entreprise, NINEA, adresse, contact,
  conditions de remboursement, durée de conservation des trajets/alertes, numéro de déclaration CDP.
  En réactivant, remettre `cgu_version` / `cgu_accepted_at` dans les métadonnées d'inscription (account.js).

## Idées en attente
- Paiement automatique via API Wave Business / Orange Money ou agrégateur (PayTech, PayDunya, CinetPay) :
  clés à mettre par Gorgui dans les secrets Supabase (Edge Functions), jamais dans le chat ni le dépôt.
- Ne garder les lieux GPS que pour les chauffeurs d'entreprise (vie privée des particuliers).
- Suivi en direct des véhicules pour les entreprises.
- Publication Play Store (PWABuilder, compte développeur 25 $, test fermé 12 testeurs / 14 jours).
