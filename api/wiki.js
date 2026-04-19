export default async function handler(req, res) {
  const { slug } = req.query;
  const params = new URLSearchParams({
    action: "query",
    titles: slug.replace(/_/g, " "),
    prop: "extracts",
    exintro: "true",
    explaintext: "true",
    format: "json",
    origin: "*"
  });
  const response = await fetch(
    "https://starwars.fandom.com/api.php?" + params.toString()
  );
  const data = await response.json();
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json(data);
}
