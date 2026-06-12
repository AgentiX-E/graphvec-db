@tck @aggregation
Feature: AGGREGATION — GROUP BY

  Scenario Outline: GROUP BY aggregation
    Given a graph with the following nodes:
      | _label  | name     | age | city |
      | Person  | Alice    | 30  | NYC  |
      | Person  | Bob      | 25  | LA   |
      | Person  | Charlie  | 35  | NYC  |
      | Person  | Diana    | 28  | SF   |
      | Person  | Eve      | 32  | NYC  |
      | Person  | Frank    | 40  | LA   |
    When executing query:
      """
      <query>
      """
    Then the result should have <expectedCount> rows

    Examples:
      | query                                            | expectedCount |
      | MATCH (n:Person) RETURN n.city, count(*) GROUP BY n.city | 3      |
      | MATCH (n:Person) WHERE n.age > 30 RETURN n.city, count(*) GROUP BY n.city | 2 |
